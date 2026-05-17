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
  EditFileTool,
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
import {
  getRegistry,
  listMCPAudit,
  buildMCPAuditRecord,
  MCPHealthMonitor,
  initAuditStore,
} from '@ara/mcp';
import {
  loadGitHubConfig,
  createGitHubTools,
  GitHubClient,
  getGitHubHealth,
  listGitHubAudit,
  buildGitHubAuditRecord,
  initGitHubAudit,
  redactGitHubSecret,
} from '@ara/github';
import { acquireLock, releaseLock, forceReleaseLock, listLocks, cleanupExpiredLocks, listLockAudit, writeLockAudit } from '@ara/locks';
import { startParallelRun, cancelParallelRun, getParallelRun, listParallelRuns } from '@ara/subagents';
import {
  createWorkspace, listWorkspaces, getWorkspace, updateWorkspace, deleteWorkspace,
  addNode, updateNode, deleteNode, getAllNodes, queryNodes,
  addEdge, deleteEdge, getAllEdges, getFullWorkspace,
  exportCanvas, executeSafeAction, writeCanvasAudit, listCanvasAudit, resolveActionSafety,
  CreateWorkspaceSchema, AddNodeSchema, UpdateNodeSchema, AddEdgeSchema, CanvasActionSchema,
} from '@ara/canvas';
import crypto from 'node:crypto';
import {
  updateWorkflowFingerprint, findRepeatedWorkflows, listWorkflowFingerprints, clearFingerprints,
  generateDraft, listDrafts, loadDraft, updateDraftStatus, approveDraft,
  listSkillStats, recordSkillUsage, listSkillLearningAudit, initStatsStore,
} from '@ara/skill-learning';
import { 
  DelegateTaskTool, 
  loadAgentProfiles, 
  selectSubagent, 
  createSubagentRun, 
  runSubagent 
} from '@ara/subagents';
import {
  createCheckpoint,
  listCheckpoints,
  getCheckpoint,
  diffCheckpoint,
  restoreCheckpoint,
  shouldCreateCheckpointBeforeTool
} from '@ara/checkpoints';

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

db.run(`
  CREATE TABLE IF NOT EXISTS subagent_runs (
    id TEXT PRIMARY KEY,
    parent_session_id TEXT NOT NULL,
    child_session_id TEXT NOT NULL,
    profile_name TEXT NOT NULL,
    task TEXT NOT NULL,
    context TEXT,
    allowed_tools TEXT,
    permission_mode TEXT,
    status TEXT NOT NULL,
    result TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    FOREIGN KEY(parent_session_id) REFERENCES sessions(id),
    FOREIGN KEY(child_session_id) REFERENCES sessions(id)
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

/**
 * Register MCP tools from a server into the global ToolRegistry.
 * Each tool is adapted via MCPToolAdapter and registered as mcp.<serverId>.<toolName>.
 */
async function registerMcpTools(serverId: string): Promise<void> {
  const { adaptDiscoveredTools } = await import('@ara/mcp');
  const registry = getRegistry();
  const server = registry.getServer(serverId);
  if (!server || server.tools.length === 0) return;

  const adapted = adaptDiscoveredTools(server.config, server.tools, server.client, 'system');
  for (const tool of adapted) {
    toolsRegistry.register(tool);
  }
}

const toolsRegistry = new ToolRegistry();
toolsRegistry.register(new ListFilesTool());
toolsRegistry.register(new ReadFileTool());
toolsRegistry.register(new WriteFileTool());
toolsRegistry.register(new EditFileTool());
toolsRegistry.register(new RunShellTool());
toolsRegistry.register(new GitStatusTool());
toolsRegistry.register(new GitDiffTool());
toolsRegistry.register(new DelegateTaskTool());

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
    version: '0.2.0',
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

// GET /api/subagents: List available agent profiles
app.get('/api/subagents', async (c) => {
  try {
    const profiles = await loadAgentProfiles(path.join(process.cwd(), '.ara', 'agents'));
    return c.json(profiles);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// GET /api/subagents/:name: Get details of a subagent profile
app.get('/api/subagents/:name', async (c) => {
  const name = c.req.param('name');
  try {
    const profiles = await loadAgentProfiles(path.join(process.cwd(), '.ara', 'agents'));
    const profile = selectSubagent(profiles, name);
    if (!profile) {
      return c.json({ error: `Profile "${name}" not found.` }, 404);
    }
    return c.json(profile);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// POST /api/subagents/runs: Delegate a task to a subagent and run it asynchronously
app.post('/api/subagents/runs', async (c) => {
  try {
    const body = await c.req.json();
    const { profileName, task, context, parentSessionId, allowedTools, maxTurns } = body;
    
    if (!profileName || !task) {
      return c.json({ error: 'Missing required fields: profileName and task.' }, 400);
    }

    const profiles = await loadAgentProfiles(path.join(process.cwd(), '.ara', 'agents'));
    const profile = selectSubagent(profiles, profileName);
    if (!profile) {
      return c.json({ error: `Profile "${profileName}" not found.` }, 404);
    }

    const parentId = parentSessionId || 'default-parent';
    const run = createSubagentRun(parentId, profile, task, context || '', {
      allowedTools,
      maxTurns
    });

    // 1. Insert child session
    db.run(
      'INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [
        run.childSessionId,
        `[Subagent: ${profile.name}] ${task.slice(0, 30)}`,
        profile.model || 'Gemini',
        new Date().toISOString(),
        new Date().toISOString()
      ]
    );

    // 2. Insert run record
    db.run(
      `INSERT INTO subagent_runs (
        id, parent_session_id, child_session_id, profile_name, task, context, allowed_tools, permission_mode, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        run.id,
        run.parentSessionId,
        run.childSessionId,
        run.profileName,
        run.task,
        run.context,
        JSON.stringify(run.allowedTools),
        run.permissionMode,
        'running',
        run.createdAt.toISOString()
      ]
    );

    // Audit log entry
    db.run(
      'INSERT INTO audit_logs (id, session_id, tool_name, input, output, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        Math.random().toString(36).substring(7),
        run.parentSessionId,
        'subagent.run.created',
        JSON.stringify({ runId: run.id }),
        `Created subagent run ${run.id}`,
        'success',
        new Date().toISOString()
      ]
    );

    // 3. Execute subagent run in background
    (async () => {
      try {
        const writeTranscriptEvent = (sessId: string, eventType: string, payload: any) => {
          try {
            const dir = path.join(process.cwd(), '.ara', 'sessions');
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const filePath = path.join(dir, `${sessId}.jsonl`);
            const seq = fs.existsSync(filePath)
              ? fs.readFileSync(filePath, 'utf8').trim().split('\n').length + 1
              : 1;

            const record = {
              seq,
              timestamp: new Date().toISOString(),
              sessionId: sessId,
              eventType,
              payload
            };
            fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
          } catch (err) {}
        };

        const writeAuditLog = (sessId: string, toolName: string, toolInput: any, outputSummary: string, status: 'success' | 'failed') => {
          db.run(
            'INSERT INTO audit_logs (id, session_id, tool_name, input, output, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [
              Math.random().toString(36).substring(7),
              sessId,
              toolName,
              JSON.stringify(toolInput),
              outputSummary,
              status,
              new Date().toISOString()
            ]
          );
        };

        const saveMsg = (sessId: string, msg: any) => {
          db.run(
            'INSERT OR REPLACE INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
            [msg.id, sessId, msg.role, msg.content, msg.createdAt.toISOString()]
          );
        };

        const runtimeCtx = {
          modelRouter: router,
          toolRegistry: toolsRegistry,
          cwd: process.cwd(),
          writeTranscriptEvent,
          writeAuditLog,
          saveMessage: saveMsg
        };

        const result = await runSubagent(run, profile, runtimeCtx);

        db.run(
          'UPDATE subagent_runs SET status = ?, result = ?, finished_at = ? WHERE id = ?',
          ['completed', JSON.stringify(result), new Date().toISOString(), run.id]
        );
      } catch (err: any) {
        db.run(
          'UPDATE subagent_runs SET status = ?, error = ?, finished_at = ? WHERE id = ?',
          ['failed', err.message, new Date().toISOString(), run.id]
        );
      }
    })();

    return c.json(run);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// GET /api/subagents/runs: Get list of all subagent runs
app.get('/api/subagents/runs', (c) => {
  const rows = db.query('SELECT * FROM subagent_runs ORDER BY created_at DESC').all() as any[];
  const runs = rows.map(r => ({
    id: r.id,
    parentSessionId: r.parent_session_id,
    childSessionId: r.child_session_id,
    profileName: r.profile_name,
    task: r.task,
    context: r.context,
    allowedTools: JSON.parse(r.allowed_tools || '[]'),
    permissionMode: r.permission_mode,
    status: r.status,
    result: r.result ? JSON.parse(r.result) : undefined,
    error: r.error,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at
  }));
  return c.json(runs);
});

// GET /api/subagents/runs/:id: Get details of a single subagent run
app.get('/api/subagents/runs/:id', (c) => {
  const id = c.req.param('id');
  const r = db.query('SELECT * FROM subagent_runs WHERE id = ?').get(id) as any;
  if (!r) {
    return c.json({ error: `Run "${id}" not found.` }, 404);
  }
  return c.json({
    id: r.id,
    parentSessionId: r.parent_session_id,
    childSessionId: r.child_session_id,
    profileName: r.profile_name,
    task: r.task,
    context: r.context,
    allowedTools: JSON.parse(r.allowed_tools || '[]'),
    permissionMode: r.permission_mode,
    status: r.status,
    result: r.result ? JSON.parse(r.result) : undefined,
    error: r.error,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at
  });
});

// POST /api/subagents/runs/:id/cancel: Cancel an active subagent run
app.post('/api/subagents/runs/:id/cancel', (c) => {
  const id = c.req.param('id');
  const r = db.query('SELECT * FROM subagent_runs WHERE id = ?').get(id) as any;
  if (!r) {
    return c.json({ error: `Run "${id}" not found.` }, 404);
  }
  if (r.status === 'running' || r.status === 'pending') {
    db.run('UPDATE subagent_runs SET status = ?, finished_at = ? WHERE id = ?', ['cancelled', new Date().toISOString(), id]);
    return c.json({ success: true, message: 'Run cancelled successfully.' });
  }
  return c.json({ error: 'Run is not in a cancellable state.' }, 400);
});

// GET /api/sessions/:id/subagent-runs: Get subagent runs associated with a parent session
app.get('/api/sessions/:id/subagent-runs', (c) => {
  const id = c.req.param('id');
  const rows = db.query('SELECT * FROM subagent_runs WHERE parent_session_id = ? ORDER BY created_at DESC').all(id) as any[];
  const runs = rows.map(r => ({
    id: r.id,
    parentSessionId: r.parent_session_id,
    childSessionId: r.child_session_id,
    profileName: r.profile_name,
    task: r.task,
    context: r.context,
    allowedTools: JSON.parse(r.allowed_tools || '[]'),
    permissionMode: r.permission_mode,
    status: r.status,
    result: r.result ? JSON.parse(r.result) : undefined,
    error: r.error,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at
  }));
  return c.json(runs);
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

    // Automatically create a checkpoint before running mutating tool if approved
    if (shouldCreateCheckpointBeforeTool(toolName, parsedInput)) {
      try {
        await createCheckpoint(approval.session_id, process.cwd(), `Automatically created before approved running tool: ${toolName}`, {
          createdBy: 'agent',
          beforeToolName: toolName,
          beforeToolInput: JSON.stringify(parsedInput)
        });
      } catch (err) {
        // Fail silently
      }
    }

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

// ── Media download helpers ──────────────────────────────────────
const UPLOADS_DIR = path.join(process.cwd(), '.ara', 'uploads');

function ensureUploadsDir() {
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

async function downloadTelegramFile(token: string, fileId: string): Promise<string | null> {
  try {
    ensureUploadsDir();
    const res = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
    const data = await res.json() as any;
    if (!data.ok || !data.result?.file_path) return null;
    const filePath = data.result.file_path as string;
    const dl = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
    if (!dl.ok) return null;
    const buf = await dl.arrayBuffer();
    const localName = `tg_${Date.now()}_${path.basename(filePath)}`;
    const localPath = path.join(UPLOADS_DIR, localName);
    fs.writeFileSync(localPath, Buffer.from(buf));
    return localPath;
  } catch { return null; }
}

async function downloadLineFile(token: string, messageId: string, ext: string): Promise<string | null> {
  try {
    ensureUploadsDir();
    const dl = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!dl.ok) return null;
    const buf = await dl.arrayBuffer();
    const localName = `line_${Date.now()}.${ext}`;
    const localPath = path.join(UPLOADS_DIR, localName);
    fs.writeFileSync(localPath, Buffer.from(buf));
    return localPath;
  } catch { return null; }
}

// -------------------------------------------------------------
// Telegram & LINE Chatbot Webhooks
// -------------------------------------------------------------

// POST /api/webhooks/telegram: Telegram Chatbot Integration Gateway
app.post('/api/webhooks/telegram', async (c) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return c.json({ error: 'TELEGRAM_BOT_TOKEN is not configured.' }, 400);
  }

  try {
    const body = await c.req.json();
    if (!body || !body.message || !body.message.chat) {
      return c.json({ ok: true, note: 'Ignored empty update.' });
    }

    const chatId = body.message.chat.id.toString();
    const sessionId = `tg-${chatId}`;
    let text = body.message.text?.trim() || '';

    // Handle media messages
    const mediaInfo: string[] = [];
    if (body.message.photo) {
      const photos = body.message.photo as { file_id: string }[];
      const largest = photos[photos.length - 1];
      if (largest?.file_id) {
        const p = await downloadTelegramFile(token, largest.file_id);
        mediaInfo.push(p ? `[Image: ${path.basename(p)}]` : '[Image: dl failed]');
      }
    }
    if (body.message.document) {
      const doc = body.message.document as { file_id: string; file_name?: string };
      const p = await downloadTelegramFile(token, doc.file_id);
      mediaInfo.push(p ? `[File: ${doc.file_name || path.basename(p)}]` : `[File: ${doc.file_name || '?'} dl failed]`);
    }
    if (body.message.voice) {
      const voice = body.message.voice as { file_id: string };
      const p = await downloadTelegramFile(token, voice.file_id);
      mediaInfo.push(p ? `[Voice: ${path.basename(p)}]` : '[Voice: dl failed]');
    }
    if (!text && mediaInfo.length === 0) {
      return c.json({ ok: true, note: 'Ignored non-text, non-media update.' });
    }
    const fullUserContent = mediaInfo.length > 0
      ? [...mediaInfo, text].filter(Boolean).join('\n')
      : text;

    // Get or create session
    let session = getSession(sessionId);
    if (!session) {
      db.run(
        'INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        [sessionId, `Telegram Chat (${chatId})`, 'Gemini', new Date().toISOString(), new Date().toISOString()]
      );
      session = getSession(sessionId)!;
    }

    // Save user message
    const userMsg: Message = {
      id: Math.random().toString(36).substring(7),
      role: 'user',
      content: text,
      createdAt: new Date()
    };
    saveMessage(sessionId, userMsg);
    session.messages.push(userMsg);

    // Send typing action to Telegram
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, action: 'typing' })
      });
    } catch (e) {}

    // Execute ReAct agent loop
    let fullContent = '';
    for await (const chunk of runtime.streamAgentLoop(session, fullUserContent, {
      onAuditLog: (log) => {
        const auditId = Math.random().toString(36).substring(7);
        db.run(
          'INSERT INTO audit_logs (id, session_id, tool_name, input, output, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [auditId, sessionId, log.toolName, JSON.stringify(log.input), log.outputSummary, log.status, new Date().toISOString()]
        );
      }
    })) {
      if (chunk.text) {
        fullContent += chunk.text;
      }
    }

    // Save finalized assistant message
    const assistantMsg: Message = {
      id: Math.random().toString(36).substring(7),
      role: 'assistant',
      content: fullContent,
      createdAt: new Date()
    };
    saveMessage(sessionId, assistantMsg);

    // Send message to Telegram
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: fullContent || "Sorry, Ara couldn't compute a reply."
      })
    });

    return c.json({ ok: true });
  } catch (err: any) {
    console.error('Telegram Webhook error:', err.message);
    return c.json({ error: err.message }, 500);
  }
});

// POST /api/webhooks/line: LINE Chatbot Integration Gateway
app.post('/api/webhooks/line', async (c) => {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    return c.json({ error: 'LINE_CHANNEL_ACCESS_TOKEN is not configured.' }, 400);
  }

  try {
    const body = await c.req.json();
    if (!body || !Array.isArray(body.events)) {
      return c.json({ ok: true, note: 'Ignored empty or invalid events payload.' });
    }

    for (const event of body.events) {
      if (event.type !== 'message' || !event.message || !event.source?.userId) continue;
      const replyToken = event.replyToken;
      const userId = event.source.userId;
      const sanitizedId = userId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 30);
      const sessionId = `line-${sanitizedId}`;
      let userContent = '';
      if (event.message.type === 'text') {
        userContent = (event.message.text || '').trim();
      }
      if (event.message.type === 'image') {
        const p = await downloadLineFile(token, event.message.id as string, 'jpg');
        userContent = p ? `[Image: ${path.basename(p)}]` : '[Image: dl failed]';
      }
      if (!userContent) continue;

      // Get or create session

        // Get or create session
        let session = getSession(sessionId);
        if (!session) {
          db.run(
            'INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
            [sessionId, `LINE Chat (${sanitizedId.slice(0, 6)})`, 'Gemini', new Date().toISOString(), new Date().toISOString()]
          );
          session = getSession(sessionId)!;
        }

        // Save user message
        const userMsg: Message = {
          id: Math.random().toString(36).substring(7),
          role: 'user',
          content: userContent,
          createdAt: new Date()
        };
        saveMessage(sessionId, userMsg);
        session.messages.push(userMsg);

        // Execute ReAct agent loop to completion (non-streaming for webhook reply)
        let fullContent = '';
        for await (const chunk of runtime.streamAgentLoop(session, userContent, {
          onAuditLog: (log) => {
            const auditId = Math.random().toString(36).substring(7);
            db.run(
              'INSERT INTO audit_logs (id, session_id, tool_name, input, output, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
              [auditId, sessionId, log.toolName, JSON.stringify(log.input), log.outputSummary, log.status, new Date().toISOString()]
            );
          }
        })) {
          if (chunk.text) {
            fullContent += chunk.text;
          }
        }

        // Save finalized assistant message
        const assistantMsg: Message = {
          id: Math.random().toString(36).substring(7),
          role: 'assistant',
          content: fullContent,
          createdAt: new Date()
        };
        saveMessage(sessionId, assistantMsg);

        // Send message to LINE using reply token
        await fetch('https://api.line.me/v2/bot/message/reply', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({
            replyToken: replyToken,
            messages: [{
              type: 'text',
              text: fullContent || "Sorry, Ara couldn't compute a reply."
            }]
          })
        });
      }
    }

    return c.json({ ok: true });
  } catch (err: any) {
    console.error('LINE Webhook error:', err.message);
    return c.json({ error: err.message }, 500);
  }
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

// GET /api/config/keys: Query presence of configured credentials
app.get('/api/config/keys', (c) => {
  return c.json({
    GEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
    OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY
  });
});

// POST /api/config/keys: Write LLM credentials directly to .env and process.env
app.post('/api/config/keys', async (c) => {
  try {
    const { GEMINI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY } = await c.req.json();
    const envPath = path.join(process.cwd(), '.env');
    
    let envContent = '';
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf8');
    }

    const lines = envContent.split('\n');
    const keyMap = new Map<string, string>();
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const idx = trimmed.indexOf('=');
        if (idx !== -1) {
          const k = trimmed.slice(0, idx).trim();
          const v = trimmed.slice(idx + 1).trim();
          keyMap.set(k, v);
        }
      }
    }

    if (GEMINI_API_KEY !== undefined) keyMap.set('GEMINI_API_KEY', GEMINI_API_KEY);
    if (OPENAI_API_KEY !== undefined) keyMap.set('OPENAI_API_KEY', OPENAI_API_KEY);
    if (ANTHROPIC_API_KEY !== undefined) keyMap.set('ANTHROPIC_API_KEY', ANTHROPIC_API_KEY);

    let newContent = '';
    keyMap.forEach((v, k) => {
      newContent += `${k}=${v}\n`;
    });

    fs.writeFileSync(envPath, newContent, 'utf8');
    
    if (GEMINI_API_KEY) process.env.GEMINI_API_KEY = GEMINI_API_KEY;
    if (OPENAI_API_KEY) process.env.OPENAI_API_KEY = OPENAI_API_KEY;
    if (ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = ANTHROPIC_API_KEY;

    return c.json({ success: true, message: 'API keys updated successfully' });
  } catch (err: any) {
    return c.json({ success: false, error: err.message }, 500);
  }
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

// GET /api/checkpoints: List all checkpoints
app.get('/api/checkpoints', async (c) => {
  const list = await listCheckpoints(process.cwd());
  return c.json(list);
});

// GET /api/sessions/:id/checkpoints: Retrieve session-specific checkpoints
app.get('/api/sessions/:id/checkpoints', async (c) => {
  const id = c.req.param('id');
  const list = await listCheckpoints(process.cwd());
  const filtered = list.filter(chk => chk.sessionId === id);
  return c.json(filtered);
});

// POST /api/sessions/:id/checkpoints: Manual checkpoint trigger
app.post('/api/sessions/:id/checkpoints', async (c) => {
  const id = c.req.param('id');
  const { reason, createdBy, specificFiles, metadata } = await c.req.json().catch(() => ({}));
  try {
    const chk = await createCheckpoint(id, process.cwd(), reason || 'Manual Checkpoint', {
      createdBy: createdBy || 'user',
      specificFiles,
      customDb: db,
      metadata
    });
    return c.json(chk, 201);
  } catch (err: any) {
    return c.text(err.message, 500);
  }
});

// GET /api/checkpoints/:id: Retrieve details of a checkpoint
app.get('/api/checkpoints/:id', async (c) => {
  const id = c.req.param('id');
  const chk = await getCheckpoint(id, process.cwd());
  if (!chk) {
    return c.text('Checkpoint not found', 404);
  }
  return c.json(chk);
});

// GET /api/checkpoints/:id/diff: Inspect diff changes relative to checkpoint
app.get('/api/checkpoints/:id/diff', async (c) => {
  const id = c.req.param('id');
  try {
    const diff = await diffCheckpoint(id, process.cwd(), db);
    return c.json(diff);
  } catch (err: any) {
    return c.text(err.message, 404);
  }
});

// POST /api/checkpoints/:id/restore: Revert workspace files and/or session messages state
app.post('/api/checkpoints/:id/restore', async (c) => {
  const id = c.req.param('id');
  const { mode } = await c.req.json().catch(() => ({ mode: 'both' }));
  
  try {
    const chk = await getCheckpoint(id, process.cwd());
    if (!chk) {
      return c.text('Checkpoint not found', 404);
    }
    
    // Create pre-restore safety checkpoint automatically!
    await createCheckpoint(chk.sessionId, process.cwd(), `before_restore_${id}`, {
      createdBy: 'system',
      customDb: db
    });

    const result = await restoreCheckpoint(id, process.cwd(), mode, db);
    return c.json(result);
  } catch (err: any) {
    return c.text(err.message, 500);
  }
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

// ── MCP / External Tools routes ────────────────────────────────────────

// Lazy-init MCP registry
let mcpInitialized = false;
async function ensureMCP() {
  if (!mcpInitialized) {
    // Init persistent audit store
    initAuditStore(path.join(process.cwd(), '.ara', 'audit', 'mcp.jsonl'));
    const registry = getRegistry();
    const result = await registry.loadConfig(process.cwd());
    mcpInitialized = true;
    // Register all already-discovered tools from enabled servers
    for (const id of registry.listServerIds()) {
      const server = registry.getServer(id);
      if (server && server.tools.length > 0) {
        await registerMcpTools(id);
      }
    }
  }
  return getRegistry();
}

// GET /api/mcp/servers — list all configured servers
app.get('/api/mcp/servers', async (c) => {
  try {
    const registry = await ensureMCP();
    const config = registry.getConfig();
    return c.json({ servers: config.servers });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// GET /api/mcp/status — MCP subsystem status summary
app.get('/api/mcp/status', async (c) => {
  try {
    const registry = await ensureMCP();
    const config = registry.getConfig();
    const enabled = config.servers.filter(s => s.enabled);
    const running = registry.listEnabled();
    const healthMonitor = new MCPHealthMonitor();
    for (const entry of running) {
      healthMonitor.update({
        serverId: entry.config.id,
        state: entry.state,
        toolCount: entry.tools.length,
      });
    }
    const audit = listMCPAudit({ limit: 5 });
    return c.json({
      configuredServers: config.servers.length,
      enabledServers: enabled.length,
      runningServers: running.length,
      healthSummary: healthMonitor.getSummary(),
      recentAuditEvents: audit.length,
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// GET /api/mcp/servers/:id — get a specific server
app.get('/api/mcp/servers/:id', async (c) => {
  try {
    const registry = await ensureMCP();
    const id = c.req.param('id');
    const server = registry.getServer(id);
    if (!server) {
      return c.json({ error: `Server "${id}" not found` }, 404);
    }
    return c.json({
      id: server.config.id,
      name: server.config.name,
      type: server.config.type,
      enabled: server.config.enabled,
      trusted: server.config.trusted,
      permissionMode: server.config.permissionMode,
      state: server.state,
      tools: server.tools,
      lastError: server.lastError,
      lastCheckedAt: server.lastCheckedAt,
      uptimeStart: server.uptimeStart,
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// POST /api/mcp/servers/:id/start — start an MCP server
app.post('/api/mcp/servers/:id/start', async (c) => {
  try {
    const registry = await ensureMCP();
    const id = c.req.param('id');
    const result = await registry.startServer(id);
    if (!result.ok) {
      return c.json({ error: result.error }, 400);
    }
    // Register tools into the global ToolRegistry
    await registerMcpTools(id);
    buildMCPAuditRecord({
      eventType: 'mcp.server.started',
      serverId: id,
      serverName: id,
      sessionId: 'api',
      startedAt: new Date().toISOString(),
    });
    return c.json({ ok: true, tools: result.tools });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// POST /api/mcp/servers/:id/stop — stop an MCP server
app.post('/api/mcp/servers/:id/stop', async (c) => {
  try {
    const registry = await ensureMCP();
    const id = c.req.param('id');
    const result = await registry.stopServer(id);
    if (!result.ok) {
      return c.json({ error: result.error }, 400);
    }
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// POST /api/mcp/servers/:id/restart — restart an MCP server
app.post('/api/mcp/servers/:id/restart', async (c) => {
  try {
    const registry = await ensureMCP();
    const id = c.req.param('id');
    const result = await registry.restartServer(id);
    if (!result.ok) {
      return c.json({ error: result.error }, 400);
    }
    await registerMcpTools(id);
    return c.json({ ok: true, tools: result.tools });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// POST /api/mcp/servers/:id/reconnect — reconnect a failed server
app.post('/api/mcp/servers/:id/reconnect', async (c) => {
  try {
    const registry = await ensureMCP();
    const id = c.req.param('id');
    const result = await registry.reconnectServer(id);
    if (!result.ok) {
      return c.json({ error: result.error }, 400);
    }
    await registerMcpTools(id);
    return c.json({ ok: true, tools: result.tools });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// GET /api/mcp/audit — list MCP audit records
app.get('/api/mcp/audit', async (c) => {
  try {
    await ensureMCP();
    const serverId = c.req.query('serverId') || undefined;
    const sessionId = c.req.query('sessionId') || undefined;
    const limit = c.req.query('limit') ? parseInt(c.req.query('limit')!) : undefined;
    const records = listMCPAudit({ serverId, sessionId, limit });
    return c.json({ records });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// GET /api/mcp/health — health check all servers
app.get('/api/mcp/health', async (c) => {
  try {
    const registry = await ensureMCP();
    const results = await registry.healthCheck();
    return c.json({ results });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ── Section A: Additional MCP Routes ─────────────────────────────────

// GET /api/mcp — MCP overview
app.get('/api/mcp', async (c) => {
  try {
    const registry = await ensureMCP();
    const config = registry.getConfig();
    const enabled = config.servers.filter(s => s.enabled);
    const running = registry.listEnabled();
    const allTools: { serverId: string; serverName: string; tools: any[] }[] = [];
    for (const entry of running) {
      allTools.push({
        serverId: entry.config.id,
        serverName: entry.config.name,
        tools: entry.tools,
      });
    }
    const healthMonitor = new MCPHealthMonitor();
    for (const entry of running) {
      healthMonitor.update({
        serverId: entry.config.id,
        state: entry.state,
        toolCount: entry.tools.length,
      });
    }
    return c.json({
      servers: config.servers.length,
      enabled: enabled.length,
      running: running.length,
      healthSummary: healthMonitor.getSummary(),
      discoveredTools: allTools,
      auditEvents: listMCPAudit({ limit: 3 }),
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// GET /api/mcp/servers/:id/tools — list discovered tools for one server
app.get('/api/mcp/servers/:id/tools', async (c) => {
  try {
    const registry = await ensureMCP();
    const id = c.req.param('id');
    const server = registry.getServer(id);
    if (!server) return c.json({ error: `Server "${id}" not found` }, 404);
    return c.json({ serverId: id, tools: server.tools, state: server.state });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// GET /api/mcp/tools — list all discovered MCP tools across all servers
app.get('/api/mcp/tools', async (c) => {
  try {
    const registry = await ensureMCP();
    const all: any[] = [];
    const running = registry.listEnabled();
    for (const entry of running) {
      for (const tool of entry.tools) {
        all.push({
          fullName: `mcp.${entry.config.id}.${tool.name}`,
          serverId: entry.config.id,
          serverName: entry.config.name,
          name: tool.name,
          description: tool.description,
          dangerLevel: tool.dangerLevel,
          mutating: tool.mutating,
          inputSchema: tool.inputSchema,
        });
      }
    }
    return c.json({ tools: all });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// POST /api/mcp/tools/:fullToolName/call — call an MCP tool through the full safety pipeline
app.post('/api/mcp/tools/:fullToolName/call', async (c) => {
  try {
    const fullToolName = c.req.param('fullToolName');
    const { sessionId, input } = await c.req.json() as { sessionId?: string; input?: Record<string, unknown> };

    if (!sessionId) return c.json({ error: 'sessionId is required' }, 400);

    // Parse fullToolName = mcp.<serverId>.<toolName>
    const parts = fullToolName.split('.');
    if (parts.length < 3 || parts[0] !== 'mcp') {
      return c.json({ error: `Invalid tool name "${fullToolName}". Format: mcp.<serverId>.<toolName>` }, 400);
    }
    const serverId = parts[1];
    const toolName = parts.slice(2).join('.');

    const registry = await ensureMCP();
    const server = registry.getServer(serverId);
    if (!server) return c.json({ error: `Server "${serverId}" not found` }, 404);
    if (!server.config.enabled) return c.json({ error: `Server "${serverId}" is disabled` }, 403);

    const tool = server.tools.find(t => t.name === toolName);
    if (!tool) return c.json({ error: `Tool "${toolName}" not found on server "${serverId}"` }, 404);

    // Create MCPToolAdapter and run through full safety pipeline
    const { MCPToolAdapter } = await import('@ara/mcp');
    const adapter = new MCPToolAdapter({
      serverConfig: server.config,
      discoveredTool: tool,
      mcpClient: server.client,
      sessionId,
    });

    const result = await adapter.run(input || {}, {
      cwd: process.cwd(),
      sessionId,
      permissionMode: server.config.permissionMode,
    });

    if (!result.success && result.error?.includes('AWAITING APPROVAL')) {
      return c.json({ awaitingApproval: true, error: result.error });
    }

    return c.json({ ok: result.success, output: result.output, error: result.error });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// POST /api/mcp/config/validate — validate MCP config format without applying
app.post('/api/mcp/config/validate', async (c) => {
  try {
    const body = await c.req.json();
    const { validateMCPConfig } = await import('@ara/mcp');
    const result = validateMCPConfig(body);
    if (!result.ok) {
      return c.json({ valid: false, error: result.error });
    }
    return c.json({ valid: true, data: result.data });
  } catch (e: any) {
    return c.json({ valid: false, error: e.message }, 400);
  }
});

// ── Tool Refresh Routes ────────────────────────────────────────────

// POST /api/mcp/servers/:id/tools/refresh — refresh tools for one server
app.post('/api/mcp/servers/:id/tools/refresh', async (c) => {
  try {
    const registry = await ensureMCP();
    const id = c.req.param('id');
    const result = await registry.refreshTools(id);
    if (!result.ok) return c.json({ error: result.error }, 400);
    // Re-register tools in Tool Registry
    await registerMcpTools(id);
    return c.json({ ok: true, tools: result.tools, removed: result.removed });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// POST /api/mcp/tools/refresh — refresh tools for all running servers
app.post('/api/mcp/tools/refresh', async (c) => {
  try {
    const registry = await ensureMCP();
    const result = await registry.refreshAllTools();
    // Re-register tools for each refreshed server
    for (const r of result.results) {
      if (r.ok) {
        await registerMcpTools(r.serverId);
      }
    }
    return c.json(result);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ── GitHub Integration Routes ──────────────────────────────────────

let ghInitialized = false;
let ghClient: GitHubClient | null = null;
let ghConfig: any = null;

async function ensureGitHub() {
  if (!ghInitialized) {
    const cfg = await loadGitHubConfig(process.cwd());
    ghConfig = cfg;
    initGitHubAudit(null); // memory-only for now
    if (cfg.enabled) {
      ghClient = new GitHubClient(cfg);
    }
    ghInitialized = true;
  }
  return { config: ghConfig, client: ghClient };
}

// GET /api/github — GitHub integration overview
app.get('/api/github', async (c) => {
  try {
    const { config, client } = await ensureGitHub();
    return c.json({
      enabled: config.enabled,
      defaultOwner: config.defaultOwner,
      defaultRepo: config.defaultRepo,
      tokenPresent: client ? client.getTokenPresent() : false,
      readOnly: config.readOnly,
      allowedRepos: config.allowedRepos,
      permissionMode: config.permissionMode,
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// GET /api/github/status — detailed health
app.get('/api/github/status', async (c) => {
  try {
    const { config, client } = await ensureGitHub();
    const health = getGitHubHealth(config, client ? client.getTokenPresent() : false);
    return c.json(health);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Helper: execute a GitHub tool through the safety pipeline
async function callGitHubTool(toolName: string, params: Record<string, unknown>, sessionId: string, c: any) {
  const { config, client } = await ensureGitHub();
  if (!client) return c.json({ error: 'GitHub integration is not configured' }, 400);
  if (!config.enabled) return c.json({ error: 'GitHub integration is disabled' }, 403);

  const tools = createGitHubTools(client, config);
  const tool = tools.find(t => t.name === toolName);
  if (!tool) return c.json({ error: `Unknown GitHub tool: ${toolName}` }, 404);

  const result = await tool.run(params, {
    cwd: process.cwd(),
    sessionId,
    permissionMode: config.permissionMode,
  });

  if (!result.success && result.error?.includes('AWAITING APPROVAL')) {
    return c.json({ awaitingApproval: true, error: result.error });
  }
  return c.json({ ok: result.success, output: result.output, error: result.error });
}

// GET /api/github/repos/:owner/:repo
app.get('/api/github/repos/:owner/:repo', async (c) => {
  try {
    const { owner, repo } = c.req.param();
    return await callGitHubTool('github.get_repo', { owner, repo }, 'api', c);
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// GET /api/github/repos/:owner/:repo/issues
app.get('/api/github/repos/:owner/:repo/issues', async (c) => {
  try {
    const { owner, repo } = c.req.param();
    return await callGitHubTool('github.list_issues', { owner, repo }, 'api', c);
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// GET /api/github/repos/:owner/:repo/issues/:issueNumber
app.get('/api/github/repos/:owner/:repo/issues/:issueNumber', async (c) => {
  try {
    const { owner, repo, issueNumber } = c.req.param();
    return await callGitHubTool('github.get_issue', { owner, repo, issue_number: parseInt(issueNumber) }, 'api', c);
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// POST /api/github/repos/:owner/:repo/issues — create issue
app.post('/api/github/repos/:owner/:repo/issues', async (c) => {
  try {
    const { owner, repo } = c.req.param();
    const { title, body, labels, sessionId } = await c.req.json();
    return await callGitHubTool('github.create_issue', { owner, repo, title, body, labels }, sessionId || 'api', c);
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// POST /api/github/repos/:owner/:repo/issues/:issueNumber/comments
app.post('/api/github/repos/:owner/:repo/issues/:issueNumber/comments', async (c) => {
  try {
    const { owner, repo, issueNumber } = c.req.param();
    const { body, sessionId } = await c.req.json();
    return await callGitHubTool('github.comment_issue', { owner, repo, issue_number: parseInt(issueNumber), body }, sessionId || 'api', c);
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// GET /api/github/repos/:owner/:repo/pulls
app.get('/api/github/repos/:owner/:repo/pulls', async (c) => {
  try {
    const { owner, repo } = c.req.param();
    return await callGitHubTool('github.list_pull_requests', { owner, repo }, 'api', c);
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// GET /api/github/repos/:owner/:repo/pulls/:pullNumber
app.get('/api/github/repos/:owner/:repo/pulls/:pullNumber', async (c) => {
  try {
    const { owner, repo, pullNumber } = c.req.param();
    return await callGitHubTool('github.get_pull_request', { owner, repo, pull_number: parseInt(pullNumber) }, 'api', c);
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// GET /api/github/repos/:owner/:repo/pulls/:pullNumber/files
app.get('/api/github/repos/:owner/:repo/pulls/:pullNumber/files', async (c) => {
  try {
    const { owner, repo, pullNumber } = c.req.param();
    return await callGitHubTool('github.get_pull_request_files', { owner, repo, pull_number: parseInt(pullNumber) }, 'api', c);
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// GET /api/github/repos/:owner/:repo/pulls/:pullNumber/diff
app.get('/api/github/repos/:owner/:repo/pulls/:pullNumber/diff', async (c) => {
  try {
    const { owner, repo, pullNumber } = c.req.param();
    return await callGitHubTool('github.get_pull_request_diff', { owner, repo, pull_number: parseInt(pullNumber) }, 'api', c);
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// POST /api/github/repos/:owner/:repo/pulls/:pullNumber/reviews
app.post('/api/github/repos/:owner/:repo/pulls/:pullNumber/reviews', async (c) => {
  try {
    const { owner, repo, pullNumber } = c.req.param();
    const { body, event, sessionId } = await c.req.json();
    return await callGitHubTool('github.create_pull_request_review', { owner, repo, pull_number: parseInt(pullNumber), body, event: event || 'COMMENT' }, sessionId || 'api', c);
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// GET /api/github/repos/:owner/:repo/check-runs/:ref
app.get('/api/github/repos/:owner/:repo/check-runs/:ref', async (c) => {
  try {
    const { owner, repo, ref } = c.req.param();
    return await callGitHubTool('github.list_check_runs', { owner, repo, ref }, 'api', c);
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// GET /api/github/repos/:owner/:repo/actions/runs
app.get('/api/github/repos/:owner/:repo/actions/runs', async (c) => {
  try {
    const { owner, repo } = c.req.param();
    return await callGitHubTool('github.list_workflow_runs', { owner, repo }, 'api', c);
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// ── Lock Routes ────────────────────────────────────────────────────

// GET /api/locks — list all active locks
app.get('/api/locks', async (c) => {
  try {
    const status = c.req.query('status') || 'active';
    const locks = listLocks({ status: status as any });
    return c.json({ locks });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// POST /api/locks — acquire a lock
app.post('/api/locks', async (c) => {
  try {
    const { sessionId, path, mode, runId, agentName, reason, ttlMs } = await c.req.json();
    if (!sessionId || !path || !mode) return c.json({ error: 'sessionId, path, and mode are required' }, 400);
    const result = acquireLock({ sessionId, path, mode, runId, agentName, reason, ttlMs });
    return c.json(result);
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// POST /api/locks/release — release a lock by ID
app.post('/api/locks/release', async (c) => {
  try {
    const { lockId } = await c.req.json();
    if (!lockId) return c.json({ error: 'lockId is required' }, 400);
    const result = releaseLock(lockId);
    return c.json(result);
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// POST /api/locks/:id/release — release a specific lock
app.post('/api/locks/:id/release', async (c) => {
  try {
    const id = c.req.param('id');
    const result = releaseLock(id);
    return c.json(result);
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// POST /api/locks/:id/force-release — force release a lock
app.post('/api/locks/:id/force-release', async (c) => {
  try {
    const id = c.req.param('id');
    const { reason } = await c.req.json();
    if (!reason) return c.json({ error: 'reason is required for force release' }, 400);
    const result = forceReleaseLock(id, reason);
    return c.json(result);
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// POST /api/locks/cleanup — clean up expired locks
app.post('/api/locks/cleanup', async (c) => {
  try {
    const count = cleanupExpiredLocks();
    return c.json({ cleaned: count });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// GET /api/locks/audit — list lock audit records
app.get('/api/locks/audit', async (c) => {
  try {
    const limit = c.req.query('limit') ? parseInt(c.req.query('limit')!) : undefined;
    const records = listLockAudit(limit);
    return c.json({ records });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// ── Parallel Subagent Routes ───────────────────────────────────────

// POST /api/subagents/parallel-runs — start parallel subagents
app.post('/api/subagents/parallel-runs', async (c) => {
  try {
    const { profiles, sessionId, maxConcurrency, task } = await c.req.json();
    if (!profiles || !Array.isArray(profiles) || profiles.length === 0) {
      return c.json({ error: 'profiles array is required' }, 400);
    }
    if (!sessionId) return c.json({ error: 'sessionId is required' }, 400);
    // Apply the shared task to all profiles if provided
    const resolvedProfiles = task
      ? profiles.map((p: any) => ({ name: p.name, task }))
      : profiles;

    const agentsDir = path.join(process.cwd(), '.ara', 'agents');
    const modelRouter = runtime.modelRouter;
    const toolRegistry = runtime.toolRegistry;

    const runtimeCtx = {
      modelRouter,
      toolRegistry,
      cwd: process.cwd(),
      writeTranscriptEvent: (sid: string, eventType: string, payload: any) => {},
      writeAuditLog: (sid: string, toolName: string, input: any, output: string, status: string) => {},
      saveMessage: (sid: string, msg: any) => {},
    };

    const run = await startParallelRun(resolvedProfiles, sessionId, agentsDir, runtimeCtx, maxConcurrency);
    return c.json(run);
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// GET /api/subagents/parallel-runs — list all parallel runs
app.get('/api/subagents/parallel-runs', async (c) => {
  try {
    const runs = listParallelRuns();
    return c.json({ runs });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// GET /api/subagents/parallel-runs/:id — get a parallel run
app.get('/api/subagents/parallel-runs/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const run = getParallelRun(id);
    if (!run) return c.json({ error: 'Parallel run not found' }, 404);
    return c.json(run);
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// POST /api/subagents/parallel-runs/:id/cancel — cancel a parallel run
app.post('/api/subagents/parallel-runs/:id/cancel', async (c) => {
  try {
    const id = c.req.param('id');
    const ok = cancelParallelRun(id);
    if (!ok) return c.json({ error: 'Parallel run not found or not running' }, 400);
    return c.json({ ok: true });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// ── Canvas Routes ─────────────────────────────────────────────────

// GET /api/canvas/workspaces
app.get('/api/canvas/workspaces', async (c) => {
  try {
    const workspaces = await listWorkspaces(process.cwd());
    return c.json({ workspaces });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// POST /api/canvas/workspaces
app.post('/api/canvas/workspaces', async (c) => {
  try {
    const body = await c.req.json();
    const parsed = CreateWorkspaceSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const ws = {
      id: crypto.randomUUID(),
      name: parsed.data.name,
      description: parsed.data.description,
      projectRoot: parsed.data.projectRoot || process.cwd(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: parsed.data.metadata,
    };
    const result = await createWorkspace(ws as any, process.cwd());
    writeCanvasAudit('canvas.workspace.created', { workspaceId: ws.id, details: ws.name });
    return c.json(result);
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// GET /api/canvas/workspaces/:id
app.get('/api/canvas/workspaces/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const data = await getFullWorkspace(id, process.cwd());
    if (!data.workspace) return c.json({ error: 'Workspace not found' }, 404);
    return c.json(data);
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// PATCH /api/canvas/workspaces/:id
app.patch('/api/canvas/workspaces/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    const updated = await updateWorkspace(id, body, process.cwd());
    if (!updated) return c.json({ error: 'Workspace not found' }, 404);
    writeCanvasAudit('canvas.workspace.updated', { workspaceId: id });
    return c.json(updated);
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// DELETE /api/canvas/workspaces/:id
app.delete('/api/canvas/workspaces/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const ok = await deleteWorkspace(id, process.cwd());
    if (!ok) return c.json({ error: 'Workspace not found' }, 404);
    writeCanvasAudit('canvas.workspace.deleted', { workspaceId: id });
    return c.json({ ok: true });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// POST /api/canvas/workspaces/:id/nodes
app.post('/api/canvas/workspaces/:id/nodes', async (c) => {
  try {
    const wsId = c.req.param('id');
    const body = await c.req.json();
    const parsed = AddNodeSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const node = {
      id: crypto.randomUUID(),
      workspaceId: wsId,
      type: parsed.data.type,
      title: parsed.data.title,
      description: parsed.data.description,
      position: parsed.data.position || { x: 0, y: 0 },
      data: parsed.data.data || {},
      sourceRef: parsed.data.sourceRef,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const result = await addNode(wsId, node as any, process.cwd());
    if (!result) return c.json({ error: 'Workspace not found' }, 404);
    writeCanvasAudit('canvas.node.created', { workspaceId: wsId, nodeId: node.id, details: node.type });
    return c.json(result);
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// PATCH /api/canvas/workspaces/:id/nodes/:nodeId
app.patch('/api/canvas/workspaces/:id/nodes/:nodeId', async (c) => {
  try {
    const { id: wsId, nodeId } = c.req.param();
    const body = await c.req.json();
    const parsed = UpdateNodeSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const result = await updateNode(wsId, nodeId, parsed.data, process.cwd());
    if (!result) return c.json({ error: 'Node not found' }, 404);
    writeCanvasAudit('canvas.node.updated', { workspaceId: wsId, nodeId });
    return c.json(result);
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// DELETE /api/canvas/workspaces/:id/nodes/:nodeId
app.delete('/api/canvas/workspaces/:id/nodes/:nodeId', async (c) => {
  try {
    const { id: wsId, nodeId } = c.req.param();
    const ok = await deleteNode(wsId, nodeId, process.cwd());
    if (!ok) return c.json({ error: 'Node not found' }, 404);
    writeCanvasAudit('canvas.node.deleted', { workspaceId: wsId, nodeId });
    return c.json({ ok: true });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// POST /api/canvas/workspaces/:id/edges
app.post('/api/canvas/workspaces/:id/edges', async (c) => {
  try {
    const wsId = c.req.param('id');
    const body = await c.req.json();
    const parsed = AddEdgeSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const edge = {
      id: crypto.randomUUID(),
      workspaceId: wsId,
      fromNodeId: parsed.data.fromNodeId,
      toNodeId: parsed.data.toNodeId,
      label: parsed.data.label,
      type: parsed.data.type || 'reference',
      createdAt: new Date().toISOString(),
      metadata: parsed.data.metadata,
    };
    const result = await addEdge(wsId, edge as any, process.cwd());
    if (!result) return c.json({ error: 'Edge could not be created — nodes may not exist' }, 400);
    writeCanvasAudit('canvas.edge.created', { workspaceId: wsId, edgeId: edge.id });
    return c.json(result);
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// DELETE /api/canvas/workspaces/:id/edges/:edgeId
app.delete('/api/canvas/workspaces/:id/edges/:edgeId', async (c) => {
  try {
    const { id: wsId, edgeId } = c.req.param();
    const ok = await deleteEdge(wsId, edgeId, process.cwd());
    if (!ok) return c.json({ error: 'Edge not found' }, 404);
    writeCanvasAudit('canvas.edge.deleted', { workspaceId: wsId, edgeId });
    return c.json({ ok: true });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// POST /api/canvas/workspaces/:id/actions
app.post('/api/canvas/workspaces/:id/actions', async (c) => {
  try {
    const wsId = c.req.param('id');
    const body = await c.req.json();
    const parsed = CanvasActionSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

    const safety = resolveActionSafety(parsed.data.action);
    if (safety !== 'safe') {
      return c.json({
        awaitingApproval: true,
        action: parsed.data.action,
        safety,
        message: `Action "${parsed.data.action}" has danger level "${safety}" and requires API dispatch through Permission Engine + Approval Gate.`,
      });
    }

    const result = await executeSafeAction(wsId, parsed.data.nodeId, parsed.data.action, parsed.data.params, process.cwd());
    writeCanvasAudit('canvas.action.executed', { workspaceId: wsId, nodeId: parsed.data.nodeId, details: parsed.data.action });
    return c.json(result);
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// GET /api/canvas/workspaces/:id/export
app.get('/api/canvas/workspaces/:id/export', async (c) => {
  try {
    const id = c.req.param('id');
    const result = await exportCanvas(id, process.cwd());
    if (!result) return c.json({ error: 'Workspace not found' }, 404);
    writeCanvasAudit('canvas.exported', { workspaceId: id });
    return c.json(result);
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// GET /api/canvas/audit
app.get('/api/canvas/audit', async (c) => {
  try {
    const limit = c.req.query('limit') ? parseInt(c.req.query('limit')!) : undefined;
    return c.json({ records: listCanvasAudit(limit) });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// ── Skill Learning Routes ──────────────────────────────────────────

let slInitialized = false;
async function ensureSL() {
  if (!slInitialized) {
    initFingerprintStore(path.join(process.cwd(), '.ara', 'skill-learning', 'workflows.jsonl'));
    initStatsStore(path.join(process.cwd(), '.ara', 'skill-learning', 'usage.jsonl'));
    slInitialized = true;
  }
}

// GET /api/skill-learning — overview
app.get('/api/skill-learning', async (c) => {
  try {
    await ensureSL();
    const workflows = listWorkflowFingerprints();
    const drafts = await listDrafts(process.cwd());
    return c.json({
      workflowCount: workflows.length,
      repeatedCount: findRepeatedWorkflows(3).length,
      draftCount: drafts.length,
    });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// GET /api/skill-learning/workflows
app.get('/api/skill-learning/workflows', async (c) => {
  try {
    await ensureSL();
    const threshold = parseInt(c.req.query('threshold') || '3');
    const repeated = findRepeatedWorkflows(threshold);
    return c.json({ workflows: repeated.length > 0 ? repeated : listWorkflowFingerprints() });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// POST /api/skill-learning/analyze — analyze session and generate drafts
app.post('/api/skill-learning/analyze', async (c) => {
  try {
    const { goal, toolSequence, filesTouched } = await c.req.json();
    if (!goal || !toolSequence) return c.json({ error: 'goal and toolSequence required' }, 400);

    const fp = updateWorkflowFingerprint({
      goal, toolSequence, filesTouched, outcome: 'success',
    });

    let draft = null;
    if (fp.count >= 3) {
      draft = await generateDraft(fp, process.cwd());
    }

    return c.json({ fingerprint: fp, draft, threshold: 3, met: fp.count >= 3 });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// GET /api/skill-learning/drafts
app.get('/api/skill-learning/drafts', async (c) => {
  try {
    await ensureSL();
    const drafts = await listDrafts(process.cwd());
    return c.json({ drafts });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// GET /api/skill-learning/drafts/:id
app.get('/api/skill-learning/drafts/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const draft = await loadDraft(id, process.cwd());
    if (!draft) return c.json({ error: 'Draft not found' }, 404);
    return c.json(draft);
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// POST /api/skill-learning/drafts/:id/approve
app.post('/api/skill-learning/drafts/:id/approve', async (c) => {
  try {
    const id = c.req.param('id');
    const draft = await loadDraft(id, process.cwd());
    if (!draft) return c.json({ error: 'Draft not found' }, 404);
    if (draft.status !== 'draft') return c.json({ error: `Draft is already ${draft.status}` }, 400);

    const result = await approveDraft(draft, process.cwd());
    await updateDraftStatus(id, 'approved', process.cwd());

    return c.json({ ok: true, skillName: result.skillName, version: result.version, isNew: result.isNew });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// POST /api/skill-learning/drafts/:id/reject
app.post('/api/skill-learning/drafts/:id/reject', async (c) => {
  try {
    const id = c.req.param('id');
    const draft = await loadDraft(id, process.cwd());
    if (!draft) return c.json({ error: 'Draft not found' }, 404);
    const updated = await updateDraftStatus(id, 'rejected', process.cwd());
    return c.json({ ok: true, status: updated!.status });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// GET /api/skill-learning/drafts/:id/diff
app.get('/api/skill-learning/drafts/:id/diff', async (c) => {
  try {
    const id = c.req.param('id');
    const draft = await loadDraft(id, process.cwd());
    if (!draft) return c.json({ error: 'Draft not found' }, 404);
    const { approveDraft: ad, skillExists: se } = await import('@ara/skill-learning');
    const exists = await se(draft.proposedSkillName, process.cwd());
    return c.json({
      draft,
      existingSkill: exists,
      newContent: draft.body,
    });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// GET /api/skill-learning/stats
app.get('/api/skill-learning/stats', async (c) => {
  try {
    const stats = listSkillStats();
    return c.json({ stats });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// Helper: convert transcript JSONL events to SessionTranscriptEntry[]
function transcriptToEntries(records: any[]): any[] {
  return records
    .filter(r => r && r.payload && (r.eventType === 'message' || r.payload.role))
    .map(r => ({
      role: r.payload.role || 'unknown',
      content: r.payload.content || '',
      toolCalls: r.payload.toolCalls || undefined,
      timestamp: r.timestamp,
    }));
}

// POST /api/skill-learning/analyze/session/:sessionId
app.post('/api/skill-learning/analyze/session/:sessionId', async (c) => {
  try {
    await ensureSL();
    const sessionId = c.req.param('sessionId');
    // Load transcript server-side
    const records = readTranscript(sessionId);
    if (records.length === 0) return c.json({ error: `Session "${sessionId}" not found or has no transcript` }, 404);
    const entries = transcriptToEntries(records);
    const result = await analyzeSession(sessionId, entries, process.cwd());
    return c.json({
      sessionId,
      fingerprintId: result.fingerprint?.id || null,
      count: result.fingerprint?.count || 0,
      draftCreated: !!result.draft,
      draftId: result.draft?.id || null,
      redactionWarnings: result.draft?.redactionWarnings || [],
    });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// POST /api/skill-learning/analyze/recent
app.post('/api/skill-learning/analyze/recent', async (c) => {
  try {
    await ensureSL();
    const { limit } = await c.req.json();
    const maxSessions = Math.min(Math.max(limit || 10, 1), 100);
    // Load recent sessions from SQLite
    const rows = db.query('SELECT id FROM sessions ORDER BY updated_at DESC LIMIT ?').all(maxSessions) as any[];
    const sessionIds = rows.map((r: any) => r.id);
    let fingerprintsUpdated = 0;
    let draftsCreated = 0;
    const draftIds: string[] = [];
    for (const sid of sessionIds) {
      const records = readTranscript(sid);
      if (records.length === 0) continue;
      const entries = transcriptToEntries(records);
      const result = await analyzeSession(sid, entries, process.cwd());
      fingerprintsUpdated++;
      if (result.draft) {
        draftsCreated++;
        draftIds.push(result.draft.id);
      }
    }
    return c.json({ sessionsAnalyzed: sessionIds.length, fingerprintsUpdated, draftsCreated, draftIds });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

export default {
  port: process.env.API_PORT || 3001,
  fetch: app.fetch,
};
