import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamText } from 'hono/streaming';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ChatSession, Message } from '@ara/shared';
import { 
  ToolRegistry,
  ListFilesTool, 
  ReadFileTool, 
  WriteFileTool, 
  RunShellTool, 
  GitStatusTool, 
  GitDiffTool 
} from '@ara/tools';
import { LocalMarkdownMemoryStore } from '@ara/memory';
import { LocalMarkdownSkillLoader } from '@ara/skills';
import { ModelRouter, GeminiProvider, OpenAIProvider, AnthropicProvider, OllamaProvider } from '@ara/model-router';
import { AgentRuntime } from '@ara/agent-core';
import { evaluatePermission, defaultDenyRules, type PermissionMode, type PermissionRequest } from '@ara/permissions';
import { loadHookConfig, SettingsSchema, runHooks, createHookEventPayload } from '@ara/hooks';

// 1. Initialize SQLite database for local-first session persistence
const db = new Database('ara.sqlite');
db.run(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT,
    model TEXT,
    created_at TEXT,
    updated_at TEXT
  )
`);
db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    role TEXT,
    content TEXT,
    created_at TEXT,
    FOREIGN KEY(session_id) REFERENCES sessions(id)
  )
`);
db.run(`
  CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    tool_name TEXT,
    input TEXT,
    risk_level TEXT,
    reason TEXT,
    status TEXT,
    created_at TEXT,
    FOREIGN KEY(session_id) REFERENCES sessions(id)
  )
`);
db.run(`
  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    tool_name TEXT,
    input TEXT,
    output TEXT,
    status TEXT,
    created_at TEXT,
    FOREIGN KEY(session_id) REFERENCES sessions(id)
  )
`);
db.run(`
  CREATE TABLE IF NOT EXISTS automations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    cron TEXT NOT NULL,
    prompt TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    last_run TEXT,
    created_at TEXT NOT NULL
  )
`);
db.run(`
  CREATE TABLE IF NOT EXISTS automation_runs (
    id TEXT PRIMARY KEY,
    automation_id TEXT NOT NULL,
    status TEXT NOT NULL,
    output TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(automation_id) REFERENCES automations(id)
  )
`);

// Active model state variable for router profile switching
let activeModel = 'Gemini';
let activePermissionMode: PermissionMode = 'default';

const sessionSequenceMap = new Map<string, number>();

function writeTranscriptEvent(sessionId: string, eventType: string, payload: any) {
  try {
    const dir = path.join(process.cwd(), '.ara', 'sessions');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const filePath = path.join(dir, `${sessionId}.jsonl`);
    
    let seq = 1;
    if (sessionSequenceMap.has(sessionId)) {
      seq = sessionSequenceMap.get(sessionId)! + 1;
    } else {
      if (fs.existsSync(filePath)) {
        try {
          const content = fs.readFileSync(filePath, 'utf8').trim();
          if (content) {
            const lines = content.split('\n');
            seq = lines.length + 1;
          }
        } catch (err) {}
      }
    }
    sessionSequenceMap.set(sessionId, seq);

    const eventRecord = {
      seq,
      timestamp: new Date().toISOString(),
      sessionId,
      eventType,
      payload
    };

    fs.appendFileSync(filePath, JSON.stringify(eventRecord) + '\n', 'utf8');
  } catch (e) {
    console.error(`Failed to write transcript event:`, e);
  }
}

function readTranscript(sessionId: string): any[] {
  const dir = path.join(process.cwd(), '.ara', 'sessions');
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  if (!fs.existsSync(filePath)) return [];
  
  const content = fs.readFileSync(filePath, 'utf8').trim();
  if (!content) return [];
  
  return content.split('\n').map(line => {
    try {
      return JSON.parse(line);
    } catch (e) {
      return { error: 'invalid json', line };
    }
  });
}

function validateTranscript(sessionId: string): { valid: boolean; errorCount: number; errors: string[] } {
  const dir = path.join(process.cwd(), '.ara', 'sessions');
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  if (!fs.existsSync(filePath)) {
    return { valid: true, errorCount: 0, errors: [] };
  }

  const content = fs.readFileSync(filePath, 'utf8').trim();
  if (!content) {
    return { valid: true, errorCount: 0, errors: [] };
  }

  const lines = content.split('\n');
  const errors: string[] = [];
  let expectedSeq = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    try {
      const record = JSON.parse(line);
      if (typeof record.seq !== 'number') {
        errors.push(`Line ${i + 1}: Missing numeric sequence field.`);
      } else if (record.seq !== expectedSeq) {
        errors.push(`Line ${i + 1}: Sequence mismatch. Expected ${expectedSeq}, got ${record.seq}.`);
      }
      if (!record.eventType) {
        errors.push(`Line ${i + 1}: Missing eventType field.`);
      }
      if (!record.sessionId) {
        errors.push(`Line ${i + 1}: Missing sessionId field.`);
      }
      expectedSeq++;
    } catch (e: any) {
      errors.push(`Line ${i + 1}: Invalid JSON formatting (${e.message}).`);
      expectedSeq++;
    }
  }

  return {
    valid: errors.length === 0,
    errorCount: errors.length,
    errors
  };
}

// Deprecated helper mapped to event transcript writer for compatibility
function writeSessionTranscript(sessionId: string, messages: Message[]) {
  // Prerendered compat bridge
}

// Helper to load session from SQLite
function getSession(id: string): ChatSession | null {
  const sessionRow = db.query('SELECT * FROM sessions WHERE id = ?').get(id) as any;
  if (!sessionRow) return null;

  const messagesRows = db.query('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC').all(id) as any[];
  const messages: Message[] = messagesRows.map(row => ({
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: new Date(row.created_at)
  }));

  return {
    id: sessionRow.id,
    title: sessionRow.title,
    model: sessionRow.model,
    messages,
    createdAt: new Date(sessionRow.created_at),
    updatedAt: new Date(sessionRow.updated_at)
  };
}

// Helper to save message to SQLite and output transcript log
function saveMessage(sessionId: string, msg: Message) {
  db.run(
    'INSERT OR REPLACE INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
    [msg.id, sessionId, msg.role, msg.content, msg.createdAt.toISOString()]
  );
  db.run(
    'UPDATE sessions SET updated_at = ? WHERE id = ?',
    [new Date().toISOString(), sessionId]
  );

  writeTranscriptEvent(sessionId, 'message.appended', { message: msg });
}

// 2. Setup Agent Core Runtime & Router
const router = new ModelRouter();
router.register(new GeminiProvider());
router.register(new OpenAIProvider());
router.register(new AnthropicProvider());
router.register(new OllamaProvider());

const toolsRegistry = new ToolRegistry();
toolsRegistry.register(new ListFilesTool());
toolsRegistry.register(new ReadFileTool());
toolsRegistry.register(new WriteFileTool());
toolsRegistry.register(new RunShellTool());
toolsRegistry.register(new GitStatusTool());
toolsRegistry.register(new GitDiffTool());

const runtime = new AgentRuntime(
  router,
  toolsRegistry,
  new LocalMarkdownMemoryStore(),
  new LocalMarkdownSkillLoader()
);

async function runHeadlessAutomation(automation: any) {
  const runId = Math.random().toString(36).substring(7);
  db.run(
    'INSERT INTO automation_runs (id, automation_id, status, output, created_at) VALUES (?, ?, ?, ?, ?)',
    [runId, automation.id, 'running', '', new Date().toISOString()]
  );
  db.run('UPDATE automations SET last_run = ? WHERE id = ?', [new Date().toISOString(), automation.id]);

  try {
    const sessionId = 'auto-' + Math.random().toString(36).substring(7);
    db.run(
      'INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [sessionId, `[Auto] ${automation.name}`, 'Gemini', new Date().toISOString(), new Date().toISOString()]
    );

    const session: ChatSession = {
      id: sessionId,
      title: `[Auto] ${automation.name}`,
      model: 'Gemini',
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date()
    };

    let output = '';
    const iterator = runtime.streamAgentLoop(session, automation.prompt);

    while (true) {
      const { value, done } = await iterator.next();
      if (done) break;
      if (value && value.text) {
        output += value.text;
      }

      if (value && value.text && value.text.includes('awaitingApproval')) {
        output += '\n[Headless Run Paused: Tool requires manual user approval in the dashboard]';
        db.run(
          'UPDATE automation_runs SET status = ?, output = ? WHERE id = ?',
          ['awaitingApproval', output, runId]
        );
        return;
      }
    }

    db.run(
      'UPDATE automation_runs SET status = ?, output = ? WHERE id = ?',
      ['success', output || 'Execution finished with no output.', runId]
    );
  } catch (err: any) {
    db.run(
      'UPDATE automation_runs SET status = ?, output = ? WHERE id = ?',
      ['failed', `Error: ${err.message}`, runId]
    );
  }
}

// 3. Configure Hono App
const app = new Hono();

// Enable CORS for frontend Vite development
app.use('/*', cors({
  origin: '*',
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
}));

// Root endpoint
app.get('/', (c) => c.text('Ara AI Control Plane API Server v0.1'));

// GET /api/status: Retrieve API, DB, and skills status parameters
app.get('/api/status', async (c) => {
  let dbStatus = 'ok';
  try {
    db.query('SELECT 1').get();
  } catch (e) {
    dbStatus = 'error';
  }

  const pendingApprovalsRow = db.query('SELECT COUNT(*) as count FROM approvals WHERE status = "pending"').get() as any;
  const pendingApprovalsCount = pendingApprovalsRow?.count || 0;

  const skillLoader = runtime.skillLoader as LocalMarkdownSkillLoader;
  const skillsList = await skillLoader.listSkills();
  const skillsCount = skillsList.length;

  return c.json({
    status: 'ok',
    version: '0.1.0',
    database: dbStatus,
    pendingApprovalsCount,
    skillsCount,
    sandboxMode: process.env.USE_DOCKER_SANDBOX === 'true',
    memoryEnabled: true,
    activeModel,
    activePermissionMode
  });
});

// GET /api/models: List available models dynamically (including local Ollama models)
app.get('/api/models', async (c) => {
  const models = [
    { id: 'Gemini', name: 'Gemini (Default Cloud)', provider: 'Gemini' },
    { id: 'OpenAI', name: 'OpenAI (Cloud)', provider: 'OpenAI' },
    { id: 'Anthropic', name: 'Anthropic (Cloud)', provider: 'Anthropic' }
  ];

  // Try to fetch local Ollama models dynamically
  try {
    const res = await fetch('http://127.0.0.1:11434/api/tags');
    if (res.ok) {
      const data: any = await res.json();
      if (data && Array.isArray(data.models)) {
        data.models.forEach((m: any) => {
          models.push({
            id: `Ollama:${m.name}`,
            name: `Ollama - ${m.name}`,
            provider: 'Ollama'
          });
        });
      }
    }
  } catch (e) {
    // If Ollama is not running, just add a generic Ollama model option
    models.push({
      id: 'Ollama:generic',
      name: 'Ollama (Local - Offline)',
      provider: 'Ollama'
    });
  }

  return c.json({ models });
});

// GET /api/sessions: List all sessions
app.get('/api/sessions', (c) => {
  const rows = db.query('SELECT * FROM sessions ORDER BY updated_at DESC').all() as any[];
  const sessions = rows.map(row => {
    // Count messages
    const countRow = db.query('SELECT COUNT(*) as count FROM messages WHERE session_id = ?').get(row.id) as any;
    return {
      id: row.id,
      title: row.title,
      model: row.model,
      messageCount: countRow?.count || 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  });
  return c.json(sessions);
});

// POST /api/sessions: Create session
app.post('/api/sessions', async (c) => {
  const { model, title } = await c.req.json();
  const chosenModel = model || 'Gemini';
  const newSession = await runtime.createSession(chosenModel, title || 'การสนทนาใหม่');
  
  db.run(
    'INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [
      newSession.id,
      newSession.title,
      newSession.model,
      newSession.createdAt.toISOString(),
      newSession.updatedAt.toISOString()
    ]
  );

  writeTranscriptEvent(newSession.id, 'session.created', {
    model: newSession.model,
    title: newSession.title,
    createdAt: newSession.createdAt.toISOString()
  });

  return c.json(newSession, 201);
});

// GET /api/sessions/:id: Retrieve session
app.get('/api/sessions/:id', (c) => {
  const id = c.req.param('id');
  const session = getSession(id);
  if (!session) {
    return c.text('Session not found', 404);
  }
  return c.json(session);
});

// GET /api/memories: Retrieve all memories dynamically from USER.md and MEMORY.md files
app.get('/api/memories', async (c) => {
  const memoryStore = runtime.memoryStore as LocalMarkdownMemoryStore;
  const list = await memoryStore.loadAll();
  return c.json(list);
});

// GET /api/skills: Retrieve all skills dynamically from the filesystem SKILL.md files
app.get('/api/skills', async (c) => {
  const skillLoader = runtime.skillLoader as LocalMarkdownSkillLoader;
  const list = await skillLoader.listSkills();
  return c.json(list);
});

// PUT /api/sessions/:id: Update session settings (like model)
app.put('/api/sessions/:id', async (c) => {
  const id = c.req.param('id');
  const { model, title } = await c.req.json();
  
  const session = getSession(id);
  if (!session) {
    return c.text('Session not found', 404);
  }
  
  if (model) {
    db.run('UPDATE sessions SET model = ? WHERE id = ?', [model, id]);
  }
  if (title) {
    db.run('UPDATE sessions SET title = ? WHERE id = ?', [title, id]);
  }
  
  return c.json({ success: true });
});

// GET /api/automations: List all automations
app.get('/api/automations', (c) => {
  const rows = db.query('SELECT * FROM automations ORDER BY created_at DESC').all() as any[];
  return c.json(rows.map(row => ({
    id: row.id,
    name: row.name,
    cron: row.cron,
    prompt: row.prompt,
    enabled: row.enabled === 1,
    lastRun: row.last_run,
    createdAt: row.created_at
  })));
});

// POST /api/automations: Create an automation
app.post('/api/automations', async (c) => {
  const { name, cron, prompt, enabled } = await c.req.json();
  const id = Math.random().toString(36).substring(7);
  db.run(
    'INSERT INTO automations (id, name, cron, prompt, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, name, cron, prompt, enabled !== false ? 1 : 0, new Date().toISOString()]
  );
  return c.json({ success: true, id });
});

// PUT /api/automations/:id: Update an automation
app.put('/api/automations/:id', async (c) => {
  const id = c.req.param('id');
  const { name, cron, prompt, enabled } = await c.req.json();
  
  if (name !== undefined) db.run('UPDATE automations SET name = ? WHERE id = ?', [name, id]);
  if (cron !== undefined) db.run('UPDATE automations SET cron = ? WHERE id = ?', [cron, id]);
  if (prompt !== undefined) db.run('UPDATE automations SET prompt = ? WHERE id = ?', [prompt, id]);
  if (enabled !== undefined) db.run('UPDATE automations SET enabled = ? WHERE id = ?', [enabled ? 1 : 0, id]);
  
  return c.json({ success: true });
});

// DELETE /api/automations/:id: Delete an automation
app.delete('/api/automations/:id', (c) => {
  const id = c.req.param('id');
  db.run('DELETE FROM automations WHERE id = ?', [id]);
  db.run('DELETE FROM automation_runs WHERE automation_id = ?', [id]);
  return c.json({ success: true });
});

// GET /api/automations/runs: Retrieve history of automation runs
app.get('/api/automations/runs', (c) => {
  const rows = db.query(`
    SELECT r.*, a.name as automation_name 
    FROM automation_runs r 
    JOIN automations a ON r.automation_id = a.id 
    ORDER BY r.created_at DESC 
    LIMIT 50
  `).all() as any[];
  return c.json(rows.map(row => ({
    id: row.id,
    automationId: row.automation_id,
    automationName: row.automation_name,
    status: row.status,
    output: row.output,
    createdAt: row.created_at
  })));
});

// POST /api/automations/:id/trigger: Manually run an automation in a headless sandbox
app.post('/api/automations/:id/trigger', async (c) => {
  const id = c.req.param('id');
  const automation = db.query('SELECT * FROM automations WHERE id = ?').get(id) as any;
  if (!automation) return c.text('Automation not found', 404);
  
  runHeadlessAutomation(automation);
  
  return c.json({ success: true, message: 'Automation triggered successfully' });
});

// GET /api/approvals: List all pending and historical approvals
app.get('/api/approvals', (c) => {
  const rows = db.query('SELECT * FROM approvals ORDER BY created_at DESC').all() as any[];
  return c.json(rows.map(row => ({
    id: row.id,
    sessionId: row.session_id,
    toolName: row.tool_name,
    input: row.input,
    riskLevel: row.risk_level,
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at
  })));
});

// GET /api/audit-logs: List audit logs
app.get('/api/audit-logs', (c) => {
  const rows = db.query('SELECT * FROM audit_logs ORDER BY created_at DESC').all() as any[];
  return c.json(rows.map(row => ({
    id: row.id,
    sessionId: row.session_id,
    toolName: row.tool_name,
    input: row.input,
    output: row.output,
    status: row.status,
    createdAt: row.created_at
  })));
});

// POST /api/approvals/:id/resolve: Approve or reject tool call
app.post('/api/approvals/:id/resolve', async (c) => {
  const id = c.req.param('id');
  const { action } = await c.req.json(); // 'approve' | 'reject'
  
  const approval = db.query('SELECT * FROM approvals WHERE id = ?').get(id) as any;
  if (!approval) {
    return c.text('Approval request not found', 404);
  }
  
  if (approval.status !== 'pending') {
    return c.text('Approval request already resolved', 400);
  }
  
  if (action === 'reject') {
    db.run('UPDATE approvals SET status = "rejected" WHERE id = ?', [id]);
    
    // Log to Audit Log
    db.run(
      'INSERT INTO audit_logs (id, session_id, tool_name, input, output, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        Math.random().toString(36).substring(7),
        approval.session_id,
        approval.tool_name,
        approval.input,
        'Tool call was rejected by the user.',
        'failed',
        new Date().toISOString()
      ]
    );
    
    // Save system message indicating rejection
    const systemMsg: Message = {
      id: Math.random().toString(36).substring(7),
      role: 'system',
      content: `[🔒 Security Block]: User rejected execution of tool "${approval.tool_name}".`,
      createdAt: new Date()
    };
    saveMessage(approval.session_id, systemMsg);

    writeTranscriptEvent(approval.session_id, 'approval.rejected', { approvalId: id, toolName: approval.tool_name });
    
    return c.json({ success: true, status: 'rejected' });
  }
  
  if (action === 'approve') {
    db.run('UPDATE approvals SET status = "approved" WHERE id = ?', [id]);
    writeTranscriptEvent(approval.session_id, 'approval.approved', { approvalId: id, toolName: approval.tool_name });
    
    const toolName = approval.tool_name;
    const parsedInput = JSON.parse(approval.input);
    const tool = toolsRegistry.get(toolName);
    
    if (!tool) {
      writeTranscriptEvent(approval.session_id, 'tool.failed', { toolName, error: `Tool ${toolName} not found` });
      return c.text(`Tool ${toolName} not found`, 404);
    }
    
    const ctx = {
      sessionId: approval.session_id,
      userId: 'default-user',
      cwd: process.cwd(),
      memoryAccess: null,
      auditLogger: null,
      approvalChecker: null
    };
    
    writeTranscriptEvent(approval.session_id, 'tool.started', { toolName, input: parsedInput });

    // Run tool
    const result = await tool.run(parsedInput, ctx);
    
    if (result.success) {
      writeTranscriptEvent(approval.session_id, 'tool.finished', { toolName, output: result.output });
    } else {
      writeTranscriptEvent(approval.session_id, 'tool.failed', { toolName, error: result.error || 'Unknown error' });
    }

    // Log to Audit Log
    db.run(
      'INSERT INTO audit_logs (id, session_id, tool_name, input, output, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        Math.random().toString(36).substring(7),
        approval.session_id,
        toolName,
        approval.input,
        result.success ? result.output : result.error || 'Unknown error',
        result.success ? 'success' : 'failed',
        new Date().toISOString()
      ]
    );
    
    // Save tool output into messages history
    const toolResultMsg: Message = {
      id: Math.random().toString(36).substring(7),
      role: 'system',
      content: `<tool_response name="${toolName}">\n${result.success ? result.output : 'Error: ' + result.error}\n</tool_response>`,
      createdAt: new Date()
    };
    saveMessage(approval.session_id, toolResultMsg);
    
    return c.json({ 
      success: true, 
      status: 'approved', 
      output: result.success ? result.output : result.error 
    });
  }
  
  return c.text('Invalid action', 400);
});

// POST /api/sessions/:id/messages: Send message and stream SSE reply
app.post('/api/sessions/:id/messages', async (c) => {
  const id = c.req.param('id');
  const session = getSession(id);
  if (!session) {
    return c.text('Session not found', 404);
  }

  const { content } = await c.req.json();
  const isContinuation = !content;

  if (!isContinuation) {
    // 1. Create and save user message immediately
    const userMsg: Message = {
      id: Math.random().toString(36).substring(7),
      role: 'user',
      content,
      createdAt: new Date()
    };
    saveMessage(id, userMsg);
    session.messages.push(userMsg);
  }

  // 2. Stream AI Agent response using SSE
  return streamText(c, async (stream) => {
    let fullContent = '';
    
    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');

    try {
      for await (const chunk of runtime.streamAgentLoop(
        session,
        isContinuation ? '' : content,
        {
          onAuditLog: (log) => {
            const auditId = Math.random().toString(36).substring(7);
            db.run(
              'INSERT INTO audit_logs (id, session_id, tool_name, input, output, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
              [
                auditId,
                id,
                log.toolName,
                JSON.stringify(log.input),
                log.outputSummary,
                log.status,
                new Date().toISOString()
              ]
            );
            writeTranscriptEvent(id, log.status === 'success' ? 'tool.finished' : 'tool.failed', {
              toolName: log.toolName,
              output: log.outputSummary
            });
          }
        }
      )) {
        if (chunk.awaitingApproval) {
          // Write pending approval to SQLite DB
          const approvalId = Math.random().toString(36).substring(7);
          db.run(
            'INSERT INTO approvals (id, session_id, tool_name, input, risk_level, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [
              approvalId,
              id,
              chunk.awaitingApproval.toolName,
              JSON.stringify(chunk.awaitingApproval.input),
              chunk.awaitingApproval.dangerLevel,
              chunk.awaitingApproval.reason,
              'pending',
              new Date().toISOString()
            ]
          );
          writeTranscriptEvent(id, 'approval.requested', {
            approvalId,
            toolName: chunk.awaitingApproval.toolName,
            input: chunk.awaitingApproval.input,
            dangerLevel: chunk.awaitingApproval.dangerLevel,
            reason: chunk.awaitingApproval.reason
          });
        }
        if (chunk.text) {
          writeTranscriptEvent(id, 'assistant.delta', { text: chunk.text });
          fullContent += chunk.text;
          await stream.write(chunk.text);
        }
      }
      
      writeTranscriptEvent(id, 'assistant.done', { content: fullContent });

      // Save finalized assistant message
      const assistantMsg: Message = {
        id: Math.random().toString(36).substring(7),
        role: 'assistant',
        content: fullContent,
        createdAt: new Date()
      };
      saveMessage(id, assistantMsg);
    } catch (e: any) {
      await stream.write(`\n[System Error: ${e.message}]`);
    }
  });
});

function buildStructuredCompactionDigest(
  sessionId: string,
  compactedMessages: Message[],
  remainingMessages: Message[],
  pendingApprovals: any[]
): string {
  const compactedAt = new Date().toISOString();
  const compactedFromMessageId = compactedMessages[0]?.id || 'unknown';
  const compactedToMessageId = compactedMessages[compactedMessages.length - 1]?.id || 'unknown';

  const userMessages = compactedMessages.filter(m => m.role === 'user');
  const userGoal = userMessages[0]?.content.slice(0, 150) || 'None identified';

  const filesTouched = new Set<string>();
  const toolCalls: string[] = [];
  const errors: string[] = [];
  const skills: string[] = [];

  for (const msg of compactedMessages) {
    if (msg.role === 'assistant') {
      const matches = msg.content.matchAll(/<tool_call\s+name="([^"]+)">([\s\S]*?)<\/tool_call>/gi);
      for (const m of matches) {
        if (m[1]) {
          toolCalls.push(m[1]);
          if (m[1] === 'write_file' || m[1] === 'read_file' || m[1] === 'edit_file') {
            try {
              const parsed = JSON.parse(m[2] || '{}');
              if (parsed.filePath) filesTouched.add(parsed.filePath);
              if (parsed.TargetFile) filesTouched.add(parsed.TargetFile);
            } catch (e) {}
          }
          if (m[1] === 'load_skill') {
            try {
              const parsed = JSON.parse(m[2] || '{}');
              if (parsed.name) skills.push(parsed.name);
            } catch (e) {}
          }
        }
      }
      if (msg.content.includes('[System Error:')) {
        const errorMatch = msg.content.match(/\[System Error:\s*([^\]]+)\]/);
        if (errorMatch && errorMatch[1]) errors.push(errorMatch[1]);
      }
    }
  }

  const approvalsSummary = `Pending: ${pendingApprovals.length}`;

  const digest = `[Compaction Digest]
- Original Session ID: ${sessionId}
- Compacted At: ${compactedAt}
- Compacted From Message ID: ${compactedFromMessageId}
- Compacted To Message ID: ${compactedToMessageId}
- User Goal: ${userGoal}
- Current Task State: Active
- Important Decisions: Compacted old history to maintain optimal context window.
- Files Touched: ${filesTouched.size > 0 ? Array.from(filesTouched).join(', ') : 'None'}
- Tool Calls Summary: ${toolCalls.length > 0 ? toolCalls.join(', ') : 'None'}
- Approvals Summary: ${approvalsSummary}
- Errors Encountered: ${errors.length > 0 ? errors.join(', ') : 'None'}
- Unresolved Tasks: None
- Memory Used: SQLite / Markdown Stores
- Skills Used: ${skills.length > 0 ? skills.join(', ') : 'None'}
- Remaining Recent Messages: ${remainingMessages.length}`;

  return digest;
}

// POST /api/sessions/:id/compact: Prune oldest history messages to fit context limits
app.post('/api/sessions/:id/compact', (c) => {
  const id = c.req.param('id');
  const session = getSession(id);
  if (!session) {
    return c.text('Session not found', 404);
  }
  const messages = session.messages;
  
  if (messages.length <= 4) {
    return c.json({ success: true, compactedCount: 0, message: 'Session is already compact' });
  }

  const systemMessages = messages.filter(m => m.role === 'system');
  const nonSystemMessages = messages.filter(m => m.role !== 'system');

  if (nonSystemMessages.length <= 3) {
    return c.json({ success: true, compactedCount: 0, message: 'Session is already compact' });
  }

  const pendingApprovals = db.query('SELECT * FROM approvals WHERE session_id = ? AND status = "pending"').all() as any[];

  const lastUserIdx = nonSystemMessages.map(m => m.role).lastIndexOf('user');
  const latestUserMsg = lastUserIdx !== -1 ? nonSystemMessages[lastUserIdx] : null;

  const keepCount = 3;
  const toCompact = nonSystemMessages.slice(0, nonSystemMessages.length - keepCount);
  let kept = nonSystemMessages.slice(nonSystemMessages.length - keepCount);

  const compactedFiltered = toCompact.filter(m => m.id !== latestUserMsg?.id);
  if (latestUserMsg && !kept.some(m => m.id === latestUserMsg.id)) {
    kept = [latestUserMsg, ...kept];
  }

  const digestContent = buildStructuredCompactionDigest(id, compactedFiltered, kept, pendingApprovals);

  const summaryMsg: Message = {
    id: Math.random().toString(36).substring(7),
    role: 'system',
    content: digestContent,
    createdAt: new Date()
  };

  db.run('DELETE FROM messages WHERE session_id = ?', [id]);

  const newMessages = [...systemMessages, summaryMsg, ...kept];
  for (const msg of newMessages) {
    db.run(
      'INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
      [msg.id, id, msg.role, msg.content, msg.createdAt.toISOString()]
    );
  }

  db.run('UPDATE sessions SET updated_at = ? WHERE id = ?', [new Date().toISOString(), id]);
  
  writeTranscriptEvent(id, 'session.compacted', {
    compactedCount: compactedFiltered.length,
    compactedFromMessageId: compactedFiltered[0]?.id,
    compactedToMessageId: compactedFiltered[compactedFiltered.length - 1]?.id
  });

  return c.json({
    success: true,
    compactedCount: compactedFiltered.length,
    message: 'Compaction completed successfully'
  });
});

// POST /api/sessions/:id/fork: Branch conversation off at targeted message count
app.post('/api/sessions/:id/fork', async (c) => {
  const id = c.req.param('id');
  const { messageIndex } = await c.req.json();
  const index = typeof messageIndex === 'number' ? messageIndex : 9999;

  const original = getSession(id);
  if (!original) {
    return c.text('Session not found', 404);
  }

  const forkedSessionId = 'fork-' + Math.random().toString(36).substring(7);
  const forkedTitle = `[Fork] ${original.title}`;

  db.run(
    'INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [forkedSessionId, forkedTitle, original.model, new Date().toISOString(), new Date().toISOString()]
  );

  const slicedMessages = original.messages.slice(0, index + 1);
  for (const msg of slicedMessages) {
    const newMsgId = Math.random().toString(36).substring(7);
    db.run(
      'INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
      [newMsgId, forkedSessionId, msg.role, msg.content, msg.createdAt.toISOString()]
    );
  }

  const forked = getSession(forkedSessionId);
  if (forked) {
    writeTranscriptEvent(forkedSessionId, 'session.forked', {
      originalSessionId: id,
      messageIndex: index,
      slicedMessagesCount: slicedMessages.length
    });
    return c.json(forked, 201);
  }

  return c.text('Failed to fork session', 500);
});

// POST /api/sessions/:id/resume: Restore active conversation status from transcripts
app.post('/api/sessions/:id/resume', (c) => {
  const id = c.req.param('id');
  const session = getSession(id);
  if (!session) {
    return c.text('Session not found', 404);
  }

  writeTranscriptEvent(id, 'session.resumed', { resumedAt: new Date().toISOString() });
  return c.json(session);
});

// POST /api/config: Update global default model settings dynamically
app.post('/api/config', async (c) => {
  const { defaultModel } = await c.req.json();
  if (defaultModel) {
    activeModel = defaultModel;
  }
  return c.json({ success: true, activeModel });
});

// PATCH /api/sessions/:id/config: Update active model config for session
app.patch('/api/sessions/:id/config', async (c) => {
  const id = c.req.param('id');
  const { activeModel } = await c.req.json();
  if (!activeModel) {
    return c.text('Missing activeModel in payload', 400);
  }

  const session = getSession(id);
  if (!session) {
    return c.text('Session not found', 404);
  }

  db.run('UPDATE sessions SET model = ?, updated_at = ? WHERE id = ?', [
    activeModel,
    new Date().toISOString(),
    id
  ]);

  writeTranscriptEvent(id, 'session.config_updated', { activeModel });

  return c.json({ success: true, sessionId: id, activeModel });
});

// GET /api/sessions/:id/transcript: Retrieve session transcript events log
app.get('/api/sessions/:id/transcript', (c) => {
  const id = c.req.param('id');
  const records = readTranscript(id);
  return c.json(records);
});

// POST /api/sessions/:id/transcript/rebuild: Rebuild database messages from transcript events
app.post('/api/sessions/:id/transcript/rebuild', (c) => {
  const id = c.req.param('id');
  const records = readTranscript(id);
  if (records.length === 0) {
    return c.text('No transcript records found to rebuild from', 404);
  }

  const validator = validateTranscript(id);
  if (!validator.valid) {
    return c.json({ success: false, errors: validator.errors }, 400);
  }

  db.run('DELETE FROM messages WHERE session_id = ?', [id]);

  for (const record of records) {
    if (record.eventType === 'message.appended' && record.payload?.message) {
      const msg = record.payload.message;
      db.run(
        'INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
        [msg.id, id, msg.role, msg.content, msg.createdAt]
      );
    }
  }

  return c.json({ success: true, message: 'Database messages successfully rebuilt from transcript event history' });
});

// GET /api/permissions: Retrieve current permissions settings and default security rules
app.get('/api/permissions', (c) => {
  return c.json({
    success: true,
    activeMode: activePermissionMode,
    defaultRules: defaultDenyRules
  });
});

// GET /api/permissions/mode: Get active permission mode
app.get('/api/permissions/mode', (c) => {
  return c.json({
    success: true,
    mode: activePermissionMode
  });
});

// PATCH /api/permissions/mode: Update active permission mode globally
app.patch('/api/permissions/mode', async (c) => {
  const { mode } = await c.req.json();
  const validModes = ['plan', 'default', 'accept-edits', 'auto-safe', 'danger-review'];
  if (!mode || !validModes.includes(mode)) {
    return c.text(`Invalid permission mode. Expected one of: ${validModes.join(', ')}`, 400);
  }

  activePermissionMode = mode as PermissionMode;
  runtime.permissionMode = activePermissionMode; // Propagate to AgentRuntime!
  
  return c.json({
    success: true,
    mode: activePermissionMode
  });
});

// POST /api/permissions/evaluate: Dry-run check for action permission viability
app.post('/api/permissions/evaluate', async (c) => {
  const reqPayload = await c.req.json();
  
  const request: PermissionRequest = {
    toolName: reqPayload.toolName,
    input: reqPayload.input || {},
    cwd: reqPayload.cwd || process.cwd(),
    dangerLevel: reqPayload.dangerLevel || 'safe',
    sessionId: reqPayload.sessionId || 'dry-run',
    userId: reqPayload.userId || 'default-user',
    permissionMode: reqPayload.permissionMode || activePermissionMode
  };

  const result = evaluatePermission(request);
  return c.json(result);
});

// GET /api/hooks: Retrieve all active hooks and diagnostic flags
app.get('/api/hooks', (c) => {
  const config = loadHookConfig();
  return c.json({
    success: true,
    hooks: config.hooks,
    diagnostics: config.diagnostics
  });
});

// GET /api/hooks/config: Retrieve the raw loaded configuration payload
app.get('/api/hooks/config', (c) => {
  const config = loadHookConfig();
  return c.json({
    success: true,
    config
  });
});

// POST /api/hooks/validate: Dry-run validate custom settings.json hook array configurations
app.post('/api/hooks/validate', async (c) => {
  try {
    const body = await c.req.json();
    const parsed = SettingsSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({
        success: false,
        error: 'Invalid Hook configuration validation schemas',
        diagnostics: parsed.error.issues.map((i: any) => `${i.path.join('.')}: ${i.message}`)
      }, 400);
    }
    return c.json({
      success: true,
      message: 'Validation matches strict Zod hook union schemas cleanly'
    });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// POST /api/hooks/test: Mock trigger an event to test hook configurations
app.post('/api/hooks/test', async (c) => {
  try {
    const { event } = await c.req.json();
    const validEvents = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'ToolFailed', 'SessionEnd'];
    if (!event || !validEvents.includes(event)) {
      return c.json({ success: false, error: `Invalid hook lifecycle event. Expected one of: ${validEvents.join(', ')}` }, 400);
    }

    const dummyPayload = createHookEventPayload(
      event as any,
      'test-api-session-id',
      activePermissionMode,
      event === 'PreToolUse' ? { toolName: 'read_file', toolInput: { filePath: 'README.md' } } : undefined
    );

    const result = await runHooks(event as any, dummyPayload);
    return c.json({
      success: true,
      event,
      payload: dummyPayload,
      result
    });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

export default {
  port: process.env.API_PORT || 3001,
  fetch: app.fetch,
};
