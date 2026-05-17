import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { AgentRuntime } from '../packages/agent-core/src/index';
import { ModelRouter } from '../packages/model-router/src/index';
import { ToolRegistry, RunShellTool, ReadFileTool } from '../packages/tools/src/index';
import { LocalMarkdownMemoryStore } from '../packages/memory/src/index';
import { LocalMarkdownSkillLoader } from '../packages/skills/src/index';
import type { ChatSession, LLMProvider, ChatInput, ChatChunk } from '../packages/shared/src/index';

class TestProvider implements LLMProvider {
  name = 'TestModel';
  public responseText = '';
  private yieldCount = 0;

  reset() {
    this.yieldCount = 0;
  }

  async *streamChat(input: ChatInput): AsyncIterable<ChatChunk> {
    if (this.yieldCount === 0) {
      this.yieldCount++;
      yield {
        text: this.responseText,
        isFinished: true
      };
    } else {
      yield {
        text: 'I have finished executing the tool.',
        isFinished: true
      };
    }
  }

  async generateText(input: ChatInput): Promise<string> {
    return this.responseText;
  }

  async generateJSON<T>(input: ChatInput, schema: any): Promise<T> {
    return JSON.parse(this.responseText);
  }
}

describe('Ara Permission Engine - Integration Testing Suite', () => {
  let db: Database;
  let runtime: AgentRuntime;
  let testProvider: TestProvider;

  beforeAll(() => {
    // Setup temporary in-memory database
    db = new Database('test-permissions-integration.sqlite');
    db.run(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        input TEXT NOT NULL,
        output TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);

    testProvider = new TestProvider();
    const router = new ModelRouter();
    router.register(testProvider);

    const registry = new ToolRegistry();
    registry.register(new RunShellTool());
    registry.register(new ReadFileTool());

    runtime = new AgentRuntime(
      router,
      registry,
      new LocalMarkdownMemoryStore(),
      new LocalMarkdownSkillLoader()
    );
  });

  beforeEach(() => {
    testProvider.reset();
  });

  afterAll(() => {
    db.close();
    try {
      const fs = require('node:fs');
      fs.unlinkSync('test-permissions-integration.sqlite');
    } catch (e) {}
  });

  test('Deny Decision - Dangerous shell command rm -rf is blocked, returns deny, and gets recorded to audit log', async () => {
    const session: ChatSession = {
      id: 'session-deny-test',
      title: 'Deny Session',
      messages: [],
      model: 'TestModel',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    runtime.permissionMode = 'default';

    const logs: any[] = [];
    const options = {
      onAuditLog: (log: any) => {
        logs.push(log);
        db.run(
          'INSERT INTO audit_logs (id, session_id, tool_name, input, output, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [
            Math.random().toString(36).substring(7),
            session.id,
            log.toolName,
            JSON.stringify(log.input),
            log.outputSummary,
            log.status,
            new Date().toISOString()
          ]
        );
      }
    };

    // Configure our mock provider to return the dangerous tool call
    testProvider.responseText = `Let me clean this directory: <tool_call name="run_shell">{"command":"rm -rf /"}</tool_call>`;

    let hasDeniedChunk = false;
    let hasBlockedYield = false;

    // Use a small abort mechanism since infinite continueLoop in agent runtime
    for await (const chunk of runtime.streamAgentLoop(session, 'start', options)) {
      if (chunk.text && chunk.text.includes('[Security Block]')) {
        hasDeniedChunk = true;
      }
      if (chunk.blockedToolCall) {
        hasBlockedYield = true;
        expect(chunk.blockedToolCall.toolName).toBe('run_shell');
        expect(chunk.blockedToolCall.reason).toContain('rm -rf');
        break; // Stop loop once blocked
      }
    }

    expect(hasDeniedChunk).toBe(true);
    expect(hasBlockedYield).toBe(true);

    // Verify the database has the audit record
    const row = db.query('SELECT * FROM audit_logs WHERE session_id = ?').get(session.id) as any;
    expect(row).toBeDefined();
    expect(row.tool_name).toBe('run_shell');
    expect(row.status).toBe('failed');
    expect(row.output).toContain('rm -rf');
  });

  test('Ask Decision - Write operation under default mode triggers user approval gate', async () => {
    const session: ChatSession = {
      id: 'session-ask-test',
      title: 'Ask Session',
      messages: [],
      model: 'TestModel',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    runtime.permissionMode = 'default';
    testProvider.responseText = `<tool_call name="run_shell">{"command":"npm install typescript"}</tool_call>`;

    let hasAskChunk = false;
    let awaitingApprovalYield = false;

    for await (const chunk of runtime.streamAgentLoop(session, 'start')) {
      if (chunk.text && chunk.text.includes('Awaiting user approval')) {
        hasAskChunk = true;
      }
      if (chunk.awaitingApproval) {
        awaitingApprovalYield = true;
        expect(chunk.awaitingApproval.toolName).toBe('run_shell');
        break;
      }
    }

    expect(hasAskChunk).toBe(true);
    expect(awaitingApprovalYield).toBe(true);
  });

  test('Allow Decision - Safe read tool runs immediately without blocks', async () => {
    const session: ChatSession = {
      id: 'session-allow-test',
      title: 'Allow Session',
      messages: [],
      model: 'TestModel',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    runtime.permissionMode = 'default';

    const logs: any[] = [];
    const options = {
      onAuditLog: (log: any) => {
        logs.push(log);
      }
    };

    testProvider.responseText = `<tool_call name="read_file">{"filePath":"README.md"}</tool_call>`;

    let hasRunningChunk = false;

    for await (const chunk of runtime.streamAgentLoop(session, 'start', options)) {
      if (chunk.text && chunk.text.includes('Running tool')) {
        hasRunningChunk = true;
      }
    }

    expect(hasRunningChunk).toBe(true);
    expect(logs.length).toBe(1);
    expect(logs[0].toolName).toBe('read_file');
    expect(logs[0].status).toBe('success');
  });
});
