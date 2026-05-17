import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Database } from 'bun:sqlite';

import { 
  ListFilesTool, 
  ReadFileTool, 
  WriteFileTool, 
  RunShellTool,
  GitStatusTool,
  GitDiffTool,
  ToolRegistry
} from '../packages/tools/src/index';
import { LocalMarkdownMemoryStore } from '../packages/memory/src/index';
import { LocalMarkdownSkillLoader } from '../packages/skills/src/index';
import { ModelRouter, GeminiProvider, OpenAIProvider, AnthropicProvider, OllamaProvider } from '../packages/model-router/src/index';
import { AgentRuntime } from '../packages/agent-core/src/index';
import type { Message, ChatSession, ToolContext } from '../packages/shared/src/index';

const testWorkspaceDir = path.resolve(process.cwd(), 'test-sandbox');

describe('Ara AI Personal assistant - Release Candidate Audit & Verification Suite', () => {
  let db: Database;
  let toolRegistry: ToolRegistry;
  let memoryStore: LocalMarkdownMemoryStore;
  let skillLoader: LocalMarkdownSkillLoader;
  let modelRouter: ModelRouter;
  let runtime: AgentRuntime;

  beforeAll(async () => {
    // 1. Setup sandboxed workspace folder
    await fs.mkdir(testWorkspaceDir, { recursive: true });
    
    // Create mock USER.md & MEMORY.md inside sandboxed memory folder
    const memDir = path.join(testWorkspaceDir, 'memory');
    await fs.mkdir(memDir, { recursive: true });
    await fs.writeFile(path.join(memDir, 'USER.md'), '# User Profile facts\n\n- Name: Alice Cooper\n- Preferred Language: Thai\n', 'utf8');
    await fs.writeFile(path.join(memDir, 'MEMORY.md'), '# Episodic Memory\n\n- Ara Personal Assistant is active.\n- User loves clean code.\n', 'utf8');

    // Create mock skills SKILL.md
    const skillsDir = path.join(testWorkspaceDir, 'skills');
    await fs.mkdir(skillsDir, { recursive: true });
    const mockCodeReviewSkillDir = path.join(skillsDir, 'code-review');
    await fs.mkdir(mockCodeReviewSkillDir, { recursive: true });
    await fs.writeFile(path.join(mockCodeReviewSkillDir, 'SKILL.md'), `---
name: code-review
description: Custom code review skill procedure
tags:
  - programming
  - quality
---
## When to use
Use to review codes.

## Inputs
- filepath

## Procedure
1. Inspect git status
2. Review files line-by-line

## Output
Review comments
`, 'utf8');

    // 2. Setup SQLite in-memory test database
    db = new Database(':memory:');
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
        created_at TEXT
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
        created_at TEXT
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
        created_at TEXT
      )
    `);

    // Override processes cwd for sandboxing target dir
    // 3. Initialize components
    toolRegistry = new ToolRegistry();
    toolRegistry.register(new ListFilesTool());
    toolRegistry.register(new ReadFileTool());
    toolRegistry.register(new WriteFileTool());
    toolRegistry.register(new RunShellTool());
    toolRegistry.register(new GitStatusTool());
    toolRegistry.register(new GitDiffTool());

    memoryStore = new LocalMarkdownMemoryStore();
    // Override internal memoryStore resolved dir for testing
    (memoryStore as any).memoryDir = memDir;

    skillLoader = new LocalMarkdownSkillLoader();
    (skillLoader as any).skillsDir = skillsDir;

    modelRouter = new ModelRouter();
    modelRouter.register(new GeminiProvider());
    modelRouter.register(new OpenAIProvider());
    modelRouter.register(new AnthropicProvider());
    modelRouter.register(new OllamaProvider());

    runtime = new AgentRuntime(
      modelRouter,
      toolRegistry,
      memoryStore,
      skillLoader
    );
  });

  afterAll(async () => {
    db.close();
    // Cleanup sandboxed workspace
    await fs.rm(testWorkspaceDir, { recursive: true, force: true });
  });

  // =========================================================
  // 1. Model Router & Provider Abstraction Tests (Phase C)
  // =========================================================
  describe('Phase C: Chat Runtime, Model Router & Providers', () => {
    test('Router dynamically fetches available providers', () => {
      const providers = modelRouter.list();
      expect(providers).toContain('Gemini');
      expect(providers).toContain('OpenAI');
      expect(providers).toContain('Anthropic');
      expect(providers).toContain('Ollama');
    });

    test('Gemini fallback mock works when key is missing or provided', async () => {
      const provider = modelRouter.get('Gemini');
      expect(provider).toBeDefined();

      const input = {
        messages: [{ id: '1', role: 'user' as const, content: 'Hi', createdAt: new Date() }],
        systemPrompt: 'Test prompt'
      };

      let output = '';
      for await (const chunk of provider!.streamChat(input)) {
        output += chunk.text;
      }
      expect(output).toContain('Mock Mode');
    });

    test('AgentRuntime creates new sessions cleanly', async () => {
      const session = await runtime.createSession('Gemini', 'Unit Testing Conversation');
      expect(session.id).toBeDefined();
      expect(session.model).toBe('Gemini');
      expect(session.title).toBe('Unit Testing Conversation');
      expect(session.messages.length).toBe(0);
    });
  });

  // =========================================================
  // 2. Tool Registry & Path Traversal & Safety Blocking (Phase D)
  // =========================================================
  describe('Phase D: Tool Safety & Security Constraints', () => {
    const mockCtx: ToolContext = {
      sessionId: 'test-session',
      userId: 'test-user',
      cwd: testWorkspaceDir,
      memoryAccess: null,
      auditLogger: null,
      approvalChecker: null
    };

    test('Path traversal is blocked for unsafe paths outside workspace CWD', async () => {
      const readTool = toolRegistry.get('read_file') as ReadFileTool;
      const result = await readTool.run({ filePath: '../../../../windows/system32/cmd.exe' }, mockCtx);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Access denied');
    });

    test('WriteFileTool blocks writing exposed credentials / secrets', async () => {
      const writeTool = toolRegistry.get('write_file') as WriteFileTool;
      // Mocking OpenAI API Key pattern block
      const result = await writeTool.run({ 
        filePath: 'keys.txt', 
        content: 'export OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF' 
      }, mockCtx);
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('Safety Block: Content contains exposed credentials');
    });

    test('WriteFileTool writes content successfully and triggers checkpoint backups', async () => {
      const writeTool = toolRegistry.get('write_file') as WriteFileTool;
      
      // Write initially
      const result1 = await writeTool.run({ filePath: 'config.json', content: '{"status": "ok"}' }, mockCtx);
      expect(result1.success).toBe(true);

      // Overwrite, which should trigger a backup
      const result2 = await writeTool.run({ filePath: 'config.json', content: '{"status": "updated"}' }, mockCtx);
      expect(result2.success).toBe(true);
      expect(result2.output).toContain('Backup created');

      // Check if backup exists in .ara/backups
      const backupFiles = await fs.readdir(path.join(testWorkspaceDir, '.ara', 'backups'));
      expect(backupFiles.length).toBeGreaterThan(0);
    });

    test('RunShellTool blocks dangerous shell command patterns', async () => {
      const shellTool = toolRegistry.get('run_shell') as RunShellTool;
      const result = await shellTool.run({ command: 'sudo rm -rf /' }, mockCtx);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Safety Block');
    });

    test('RunShellTool blocks shell command containing secrets', async () => {
      const shellTool = toolRegistry.get('run_shell') as RunShellTool;
      const result = await shellTool.run({ command: 'echo "sk-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF"' }, mockCtx);
      expect(result.success).toBe(false);
      expect(result.error).toContain('exposed credentials');
    });
  });

  // =========================================================
  // 3. Approval Gate & Audit Logs State persistence (Phase E & F)
  // =========================================================
  describe('Phase E & F: Approval Gate & Audit logs state tracking', () => {
    test('DB properly records pending approvals and transitions', () => {
      const approvalId = 'app-test-123';
      db.run(
        'INSERT INTO approvals (id, session_id, tool_name, input, risk_level, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [approvalId, 'sess-1', 'write_file', '{"filePath":"config.json"}', 'write', 'testing', 'pending', new Date().toISOString()]
      );

      const row = db.query('SELECT * FROM approvals WHERE id = ?').get(approvalId) as any;
      expect(row).toBeDefined();
      expect(row.status).toBe('pending');
      expect(row.risk_level).toBe('write');

      // Approve state transition
      db.run('UPDATE approvals SET status = ? WHERE id = ?', ['approved', approvalId]);
      const updatedRow = db.query('SELECT * FROM approvals WHERE id = ?').get(approvalId) as any;
      expect(updatedRow.status).toBe('approved');
    });

    test('Audit log is written and retrieved cleanly', () => {
      const logId = 'log-test-123';
      db.run(
        'INSERT INTO audit_logs (id, session_id, tool_name, input, output, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [logId, 'sess-1', 'run_shell', 'dir', 'success output', 'success', new Date().toISOString()]
      );

      const row = db.query('SELECT * FROM audit_logs WHERE id = ?').get(logId) as any;
      expect(row).toBeDefined();
      expect(row.tool_name).toBe('run_shell');
      expect(row.status).toBe('success');
    });
  });

  // =========================================================
  // 4. Dynamic Memory Store Loader & Search (Phase G)
  // =========================================================
  describe('Phase G: Local Markdown Memory Store & Ranking', () => {
    test('Loads memory cleanly from USER.md and MEMORY.md files', async () => {
      const memories = await memoryStore.loadAll();
      expect(memories.length).toBeGreaterThan(0);
      
      const userFacts = memories.filter(m => m.type === 'user');
      expect(userFacts[0].content).toContain('Alice Cooper');

      const episodicFacts = memories.filter(m => m.type === 'episodic');
      expect(episodicFacts[0].content).toContain('Ara Personal Assistant is active');
    });

    test('Memory search correctly filters relevant facts', async () => {
      const matches = await memoryStore.search('Alice');
      expect(matches.length).toBe(1);
      expect(matches[0].content).toContain('Alice Cooper');
    });

    test('Appends and saves episodic memory bulletins', async () => {
      const newFact = await memoryStore.save({
        type: 'episodic',
        title: 'ความจำระยะยาว',
        content: 'User prefers dark mode layouts.',
        source: 'local-markdown',
        tags: [],
        confidence: 1.0
      });

      expect(newFact.id).toBeDefined();
      expect(newFact.content).toBe('User prefers dark mode layouts.');

      // Verify filesystem write
      const memoryContent = await fs.readFile(path.join(testWorkspaceDir, 'memory', 'MEMORY.md'), 'utf8');
      expect(memoryContent).toContain('User prefers dark mode layouts.');
    });
  });

  // =========================================================
  // 5. Skill System Frontmatter & Procedure Loader (Phase H)
  // =========================================================
  describe('Phase H: Skill frontmatter progressively loading', () => {
    test('Parses frontmatter metadata dynamically without full procedures', async () => {
      const list = await skillLoader.listSkills();
      expect(list.length).toBeGreaterThan(0);
      expect(list[0].name).toBe('code-review');
      expect(list[0].description).toBe('Custom code review skill procedure');
    });

    test('Loads full skill procedure successfully', async () => {
      const fullSkill = await skillLoader.loadSkill('code-review');
      expect(fullSkill).toBeDefined();
      console.log('Skill procedure loaded:', fullSkill!.procedure);
      expect(fullSkill!.procedure.length).toBeGreaterThan(0);
    });
  });
});
