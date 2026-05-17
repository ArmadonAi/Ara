import { expect, test, describe, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Database } from 'bun:sqlite';
import {
  loadAgentProfiles,
  selectSubagent,
  createSubagentRun,
  runSubagent,
  mergeSubagentResults,
  formatSubagentResultMarkdown,
  logSubagentAudit,
  DelegateTaskTool
} from '../src';
import { ToolRegistry, ReadFileTool, WriteFileTool, ListFilesTool, GitStatusTool, GitDiffTool } from '@ara/tools';
import { ModelRouter } from '@ara/model-router';
import type { SubagentProfile, SubagentRun } from '../src/types';

describe('Ara Subagents Unit and Integration Tests', () => {
  const tempCwd = path.join(process.cwd(), '.temp_subagent_test');
  const agentsDir = path.join(tempCwd, '.ara', 'agents');
  let toolsRegistry: ToolRegistry;
  let modelRouter: ModelRouter;

  const mockProvider = {
    name: 'Gemini',
    async generateText(input: any) {
      const messages = input.messages;
      const lastMsg = messages[messages.length - 1]?.content || '';

      if (lastMsg.includes('summarize') || lastMsg.includes('Summarize')) {
        return JSON.stringify({
          summary: 'Successful mock analysis',
          findings: ['finding 1', 'finding 2'],
          artifacts: ['test_artifact.txt'],
          nextActions: ['action 1']
        });
      }

      if (lastMsg.includes('trigger_tool')) {
        return `<tool_call name="read_file">{"filePath": "dummy.txt"}</tool_call>`;
      }

      if (lastMsg.includes('trigger_write')) {
        return `<tool_call name="write_file">{"filePath": "dummy.txt", "content": "hacked"}</tool_call>`;
      }

      return 'I completed the task successfully.';
    },
    async *streamChat(input: any) {
      yield { text: 'I completed the task successfully.', isFinished: true };
    },
    async generateJSON() {
      return {} as any;
    }
  };

  beforeAll(async () => {
    await fs.mkdir(tempCwd, { recursive: true });
    
    // Register tools
    toolsRegistry = new ToolRegistry();
    toolsRegistry.register(new ListFilesTool());
    toolsRegistry.register(new ReadFileTool());
    toolsRegistry.register(new WriteFileTool());
    toolsRegistry.register(new GitStatusTool());
    toolsRegistry.register(new GitDiffTool());

    // Register model router provider
    modelRouter = new ModelRouter();
    modelRouter.register(mockProvider as any);

    // Initialize clean sqlite db for tests
    const db = new Database('ara.sqlite');
    db.run(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT, model TEXT, created_at TEXT, updated_at TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, created_at TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, session_id TEXT, tool_name TEXT, input TEXT, risk_level TEXT, reason TEXT, status TEXT, created_at TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, session_id TEXT, tool_name TEXT, input TEXT, output TEXT, status TEXT, created_at TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS subagent_runs (id TEXT PRIMARY KEY, parent_session_id TEXT, child_session_id TEXT, profile_name TEXT, task TEXT, context TEXT, allowed_tools TEXT, permission_mode TEXT, status TEXT, result TEXT, error TEXT, created_at TEXT, started_at TEXT, finished_at TEXT)`);
    db.close();
  });

  afterAll(async () => {
    await fs.rm(tempCwd, { recursive: true, force: true });
  });

  test('Valid built-in profiles are successfully written and loaded', async () => {
    const profiles = await loadAgentProfiles(agentsDir, toolsRegistry);
    expect(profiles.length).toBe(4);
    
    const reviewer = selectSubagent(profiles, 'code-reviewer');
    expect(reviewer).toBeDefined();
    expect(reviewer!.name).toBe('code-reviewer');
    expect(reviewer!.permissionMode).toBe('plan');
    expect(reviewer!.tools).toContain('read_file');
  });

  test('Invalid profile structure or unknown tool is rejected', async () => {
    // 1. Missing name in frontmatter
    const badFilePath = path.join(agentsDir, 'bad-profile.md');
    await fs.writeFile(
      badFilePath,
      `---
description: Invalid profile lacking name
permissionMode: plan
tools:
  - read_file
---
Prompt content`,
      'utf-8'
    );

    expect(loadAgentProfiles(agentsDir, toolsRegistry)).rejects.toThrow();
    await fs.unlink(badFilePath);

    // 2. Unknown tool not in registry
    const unknownToolPath = path.join(agentsDir, 'unknown-tool.md');
    await fs.writeFile(
      unknownToolPath,
      `---
name: bad-tool-agent
description: Invalid tool spec
permissionMode: plan
tools:
  - unknown_action_tool
---
Prompt content`,
      'utf-8'
    );

    expect(loadAgentProfiles(agentsDir, toolsRegistry)).rejects.toThrow();
    await fs.unlink(unknownToolPath);
  });

  test('Subagent run is correctly initialized with isolated child session', async () => {
    const profiles = await loadAgentProfiles(agentsDir, toolsRegistry);
    const researcher = selectSubagent(profiles, 'researcher')!;

    const run = createSubagentRun('parent-session-123', researcher, 'Investigate index.ts', 'Root context', {
      allowedTools: ['read_file']
    });

    expect(run.id).toBeDefined();
    expect(run.parentSessionId).toBe('parent-session-123');
    expect(run.childSessionId.startsWith('sub-')).toBe(true);
    expect(run.profileName).toBe('researcher');
    expect(run.allowedTools).toEqual(['read_file']);
    expect(run.permissionMode).toBe('plan');
    expect(run.status).toBe('pending');
  });

  test('Subagent isolated run enforces allowedTools and permissions boundaries', async () => {
    const profiles = await loadAgentProfiles(agentsDir, toolsRegistry);
    const researcher = selectSubagent(profiles, 'researcher')!;

    const run = createSubagentRun('parent-session-123', researcher, 'trigger_tool: dummy.txt', 'context', {
      allowedTools: ['read_file']
    });

    const transcripts: any[] = [];
    const auditLogs: any[] = [];
    const messages: any[] = [];

    const runtimeCtx = {
      modelRouter,
      toolRegistry: toolsRegistry,
      cwd: tempCwd,
      writeTranscriptEvent: (sessId: string, eventType: string, payload: any) => {
        transcripts.push({ sessId, eventType, payload });
      },
      writeAuditLog: (sessId: string, toolName: string, input: any, outputSummary: string, status: 'success' | 'failed') => {
        auditLogs.push({ sessId, toolName, input, outputSummary, status });
      },
      saveMessage: (sessId: string, msg: any) => {
        messages.push({ sessId, msg });
      }
    };

    const result = await runSubagent(run, researcher, runtimeCtx);

    expect(result.summary).toBe('Successful mock analysis');
    expect(result.findings).toContain('finding 1');

    // Verify transcript events written
    expect(transcripts.some(t => t.eventType === 'subagent.started')).toBe(true);
    expect(transcripts.some(t => t.eventType === 'subagent.tool.started' && t.payload.toolName === 'read_file')).toBe(true);
    expect(transcripts.some(t => t.eventType === 'subagent.completed')).toBe(true);

    // Verify audit logs written
    expect(auditLogs.some(a => a.toolName === 'subagent.run.started')).toBe(true);
    expect(auditLogs.some(a => a.toolName === 'subagent.run.completed')).toBe(true);

    // Parent session must NOT be mutated directly
    expect(messages.every(m => m.sessId === run.childSessionId)).toBe(true);
  });

  test('Write / Edit tools are strictly denied in read-only plan mode', async () => {
    const profiles = await loadAgentProfiles(agentsDir, toolsRegistry);
    const researcher = selectSubagent(profiles, 'researcher')!;

    const run = createSubagentRun('parent-session-123', researcher, 'trigger_write: hack credentials', 'context', {
      allowedTools: ['write_file'] // Request write_file
    });

    const transcripts: any[] = [];
    const auditLogs: any[] = [];
    const messages: any[] = [];

    const runtimeCtx = {
      modelRouter,
      toolRegistry: toolsRegistry,
      cwd: tempCwd,
      writeTranscriptEvent: (sessId: string, eventType: string, payload: any) => {
        transcripts.push({ sessId, eventType, payload });
      },
      writeAuditLog: (sessId: string, toolName: string, input: any, outputSummary: string, status: 'success' | 'failed') => {
        auditLogs.push({ sessId, toolName, input, outputSummary, status });
      },
      saveMessage: (sessId: string, msg: any) => {
        messages.push({ sessId, msg });
      }
    };

    const result = await runSubagent(run, researcher, runtimeCtx);

    // Verify subagent tool blocked logs
    expect(transcripts.some(t => t.eventType === 'subagent.tool.failed')).toBe(true);
    expect(auditLogs.some(a => a.toolName === 'subagent.tool.blocked')).toBe(true);
  });

  test('Results can be correctly consolidated and formatted in Markdown', () => {
    const r1 = { summary: 'Found security issue', findings: ['Exposed credential SK1'], artifacts: ['security_report.md'], nextActions: ['Revoke key'] };
    const r2 = { summary: 'No performance issues', findings: ['Execution times under 10ms'], artifacts: [], nextActions: [] };

    const merged = mergeSubagentResults([r1, r2]);
    expect(merged.summary).toBe('Found security issue | No performance issues');
    expect(merged.findings).toContain('Exposed credential SK1');
    expect(merged.findings).toContain('Execution times under 10ms');
    expect(merged.artifacts).toContain('security_report.md');
    expect(merged.nextActions).toContain('Revoke key');

    const markdown = formatSubagentResultMarkdown(merged, 'code-reviewer');
    expect(markdown).toContain('### 🤖 Subagent [code-reviewer] Output Results');
    expect(markdown).toContain('Exposed credential SK1');
  });
});
