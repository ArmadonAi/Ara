import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from '@ara/shared';
import { Database } from 'bun:sqlite';
import * as path from 'path';
import * as fs from 'fs';
import { loadAgentProfiles } from './loadAgentProfiles';
import { selectSubagent } from './selectSubagent';
import { createSubagentRun } from './createSubagentRun';
import { runSubagent } from './runSubagent';
import { formatSubagentResultMarkdown } from './mergeSubagentResults';
import { ModelRouter, GeminiProvider, OpenAIProvider, AnthropicProvider, OllamaProvider } from '@ara/model-router';

export class DelegateTaskTool implements Tool {
  name = 'delegate_task';
  description = 'Delegate a safe read-only subtask to a specialized subagent (researcher, code-reviewer, debugger, security-reviewer).';
  dangerLevel = 'safe' as const;
  requiresApproval = false;
  inputSchema = z.object({
    profileName: z.string(),
    task: z.string(),
    context: z.string().optional().default(''),
    allowedTools: z.array(z.string()).optional(),
    maxTurns: z.number().optional()
  });

  async run(
    input: {
      profileName: string;
      task: string;
      context?: string;
      allowedTools?: string[];
      maxTurns?: number;
    },
    ctx: ToolContext
  ): Promise<ToolResult> {
    const db = new Database('ara.sqlite');

    try {
      // 1. Load profiles from .ara/agents
      const agentsDir = path.join(ctx.cwd, '.ara', 'agents');
      const profiles = await loadAgentProfiles(agentsDir);
      const profile = selectSubagent(profiles, input.profileName);

      if (!profile) {
        return {
          success: false,
          output: '',
          error: `Subagent profile "${input.profileName}" not found.`
        };
      }

      // 2. Create subagent run
      const run = createSubagentRun(ctx.sessionId, profile, input.task, input.context || '', {
        allowedTools: input.allowedTools,
        maxTurns: input.maxTurns
      });

      // 3. Insert child session and subagent run record into SQLite
      db.run(
        'INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        [run.childSessionId, `[Subagent: ${profile.name}] ${input.task.slice(0, 30)}`, profile.model || 'Gemini', new Date().toISOString(), new Date().toISOString()]
      );

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

      // Write subagent.run.created to audit
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

      // 4. Set up isolated execution context
      const modelRouter = new ModelRouter();
      modelRouter.register(new GeminiProvider());
      modelRouter.register(new OpenAIProvider());
      modelRouter.register(new AnthropicProvider());
      modelRouter.register(new OllamaProvider());

      // Helper to append transcript events in standard JSONL format
      const writeTranscriptEvent = (sessId: string, eventType: string, payload: any) => {
        try {
          const sessionsDir = path.join(ctx.cwd, '.ara', 'sessions');
          if (!fs.existsSync(sessionsDir)) {
            fs.mkdirSync(sessionsDir, { recursive: true });
          }
          const filePath = path.join(sessionsDir, `${sessId}.jsonl`);
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

      const saveMessage = (sessId: string, msg: any) => {
        db.run(
          'INSERT OR REPLACE INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
          [msg.id, sessId, msg.role, msg.content, msg.createdAt.toISOString()]
        );
      };

      const runtimeCtx = {
        modelRouter,
        toolRegistry: ctx.toolRegistry,
        cwd: ctx.cwd,
        writeTranscriptEvent,
        writeAuditLog,
        saveMessage
      };

      // 5. Run the isolated subagent loop
      const result = await runSubagent(run, profile, runtimeCtx);

      // 6. Update database record on completion
      db.run(
        'UPDATE subagent_runs SET status = ?, result = ?, finished_at = ? WHERE id = ?',
        ['completed', JSON.stringify(result), new Date().toISOString(), run.id]
      );

      const markdownResult = formatSubagentResultMarkdown(result, profile.name);

      return {
        success: true,
        output: markdownResult
      };

    } catch (e: any) {
      return {
        success: false,
        output: '',
        error: `Subagent execution failed: ${e.message}`
      };
    } finally {
      db.close();
    }
  }
}
