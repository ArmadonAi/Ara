import { evaluatePermission } from '@ara/permissions';
import { runHooks, createHookEventPayload } from '@ara/hooks';
import type { SubagentRun, SubagentResult, SubagentProfile } from './types';
import { SubagentResultSchema } from './schema';
import { mergeSubagentResults } from './mergeSubagentResults';

export interface SubagentRuntimeContext {
  modelRouter: any;
  toolRegistry: any;
  cwd: string;
  writeTranscriptEvent: (sessionId: string, eventType: string, payload: any) => void;
  writeAuditLog: (sessionId: string, toolName: string, input: any, outputSummary: string, status: 'success' | 'failed') => void;
  saveMessage: (sessionId: string, msg: { id: string; role: 'user' | 'assistant' | 'system'; content: string; createdAt: Date }) => void;
}

export async function runSubagent(
  run: SubagentRun,
  profile: SubagentProfile,
  ctx: SubagentRuntimeContext
): Promise<SubagentResult> {
  // 1. Write run.started audit and transcript
  ctx.writeTranscriptEvent(run.parentSessionId, 'subagent.started', {
    runId: run.id,
    profileName: run.profileName,
    task: run.task,
    childSessionId: run.childSessionId,
    parentSessionId: run.parentSessionId
  });
  ctx.writeAuditLog(run.parentSessionId, 'subagent.run.started', { runId: run.id }, 'Subagent execution started', 'success');

  // --- SubagentStart lifecycle hook ---
  const startPayload = createHookEventPayload('SubagentStart' as any, run.childSessionId, run.permissionMode, {
    parentSessionId: run.parentSessionId,
    profileName: run.profileName,
    task: run.task
  });
  await runHooks('SubagentStart' as any, startPayload);

  // Initialize isolated message history
  const childSessionMessages: Array<{ id: string; role: 'user' | 'assistant' | 'system'; content: string; createdAt: Date }> = [];

  // Add system prompt
  childSessionMessages.push({
    id: Math.random().toString(36).substring(7),
    role: 'system',
    content: profile.systemPrompt,
    createdAt: new Date()
  });

  // Add task context as user message
  const userContent = `TASK: ${run.task}\n\nCONTEXT: ${run.context || 'None'}`;
  const userMsg = {
    id: Math.random().toString(36).substring(7),
    role: 'user' as const,
    content: userContent,
    createdAt: new Date()
  };
  childSessionMessages.push(userMsg);
  ctx.saveMessage(run.childSessionId, userMsg);

  let providerName = profile.model || 'default';
  let provider = ctx.modelRouter.get(providerName);
  if (!provider) {
    provider = ctx.modelRouter.get('Gemini') || ctx.modelRouter.get('default') || (ctx.modelRouter.list ? ctx.modelRouter.list().map((name: string) => ctx.modelRouter.get(name))[0] : undefined);
  }
  if (!provider) {
    throw new Error(`Provider not found for model: ${profile.model}`);
  }

  // Filter tools by subagent profile allowlist (supports wildcards like "mcp.github.*")
  const isToolAllowed = (toolName: string): boolean => {
    return run.allowedTools.some((allowed: string) => {
      if (allowed === toolName) return true;
      // Namespace wildcard: mcp.github.* matches mcp.github.get_issue, mcp.github.list_repos, etc.
      if (allowed.endsWith('.*')) {
        const prefix = allowed.slice(0, -2); // "mcp.github." from "mcp.github.*"
        return toolName.startsWith(prefix);
      }
      return false;
    });
  };

  const toolsDescription = ctx.toolRegistry.list()
    .filter((t: any) => {
      // 1. Must be in profile allowlist
      if (!isToolAllowed(t.name)) return false;
      // 2. Subagents cannot call mutating MCP tools
      if (t.name.startsWith('mcp.') && (t.dangerLevel === 'write' || t.dangerLevel === 'dangerous')) return false;
      return true;
    })
    .map((t: any) => `- **${t.name}**: ${t.description} (Danger Level: ${t.dangerLevel})`)
    .join('\n');

  const subagentSystemPrompt = `${profile.systemPrompt}

Available Subagent Tools:
${toolsDescription || 'None'}

Tool Calling Rules:
1. To call an allowed tool, output a block in the XML format:
<tool_call name="tool_name">
{
  "parameter_name": "value"
}
</tool_call>
2. You can call exactly one tool per turn.
3. If you decide to call a tool, do NOT output anything after the </tool_call> tag. Let the runtime execute the tool first.
4. After a tool runs, you will receive a <tool_response> in the next turn.

Guidelines:
- Focus solely on the task assigned.
- You are read-only: you cannot write files or execute commands.`;

  let currentTurn = 0;
  const maxTurns = profile.maxTurns || 8;
  let continueLoop = true;

  while (continueLoop && currentTurn < maxTurns) {
    currentTurn++;

    // Generate assistant text
    let completeResponse = '';
    try {
      completeResponse = await provider.generateText({
        messages: childSessionMessages,
        systemPrompt: subagentSystemPrompt
      });
    } catch (e: any) {
      // Transcript failed event
      ctx.writeTranscriptEvent(run.childSessionId, 'subagent.failed', { runId: run.id, error: e.message });
      ctx.writeAuditLog(run.parentSessionId, 'subagent.run.failed', { runId: run.id }, `LLM error: ${e.message}`, 'failed');
      throw e;
    }

    const assistantMsg = {
      id: Math.random().toString(36).substring(7),
      role: 'assistant' as const,
      content: completeResponse,
      createdAt: new Date()
    };
    childSessionMessages.push(assistantMsg);
    ctx.saveMessage(run.childSessionId, assistantMsg);

    // Look for tool calls
    const toolCallRegex = /<tool_call\s+name="([^"]+)"\s*>([\s\S]+?)<\/tool_call>/i;
    const match = completeResponse.match(toolCallRegex);

    if (match) {
      const toolName = match[1]?.trim() || '';
      const rawInput = match[2]?.trim() || '{}';

      let input: any = {};
      try {
        input = JSON.parse(rawInput);
      } catch (e: any) {
        const errorContent = `<tool_response name="${toolName}">\nError: Invalid JSON input\n</tool_response>`;
        const sysErrorMsg = {
          id: Math.random().toString(36).substring(7),
          role: 'system' as const,
          content: errorContent,
          createdAt: new Date()
        };
        childSessionMessages.push(sysErrorMsg);
        ctx.saveMessage(run.childSessionId, sysErrorMsg);
        continue;
      }

      ctx.writeTranscriptEvent(run.childSessionId, 'subagent.tool.started', { toolName, input });

      // --- SubagentToolUse lifecycle hook ---
      const toolUsePayload = createHookEventPayload('SubagentToolUse' as any, run.childSessionId, run.permissionMode, {
        toolName,
        toolInput: input
      });
      await runHooks('SubagentToolUse' as any, toolUsePayload);

      // Check tool allowlist
      if (!run.allowedTools.includes(toolName)) {
        // Block tool call and audit
        ctx.writeTranscriptEvent(run.childSessionId, 'subagent.tool.failed', { toolName, error: 'Access Denied: Tool not allowed by subagent profile' });
        ctx.writeAuditLog(run.childSessionId, 'subagent.tool.blocked', { toolName, input }, 'Tool not allowed by profile policy', 'failed');
        
        const blockMsg = {
          id: Math.random().toString(36).substring(7),
          role: 'system' as const,
          content: `<tool_response name="${toolName}">\nSecurity Error: Access Denied. Tool not allowed in subagent allowlist.\n</tool_response>`,
          createdAt: new Date()
        };
        childSessionMessages.push(blockMsg);
        ctx.saveMessage(run.childSessionId, blockMsg);
        continue;
      }

      // Check write tools or run_shell safety block
      const dangerousTools = ['write_file', 'edit_file', 'run_shell'];
      if (dangerousTools.includes(toolName)) {
        ctx.writeTranscriptEvent(run.childSessionId, 'subagent.tool.failed', { toolName, error: 'Access Denied: File writing and shell execution are strictly blocked in this read-only subagents phase' });
        ctx.writeAuditLog(run.childSessionId, 'subagent.tool.blocked', { toolName, input }, 'Dangerous tool blocked in read-only phase', 'failed');

        const blockMsg = {
          id: Math.random().toString(36).substring(7),
          role: 'system' as const,
          content: `<tool_response name="${toolName}">\nSecurity Error: Access Denied. File writing and shell execution are strictly blocked for subagents.\n</tool_response>`,
          createdAt: new Date()
        };
        childSessionMessages.push(blockMsg);
        ctx.saveMessage(run.childSessionId, blockMsg);
        continue;
      }

      // Permissions evaluation
      const tool = ctx.toolRegistry.get(toolName);
      if (!tool) {
        ctx.writeTranscriptEvent(run.childSessionId, 'subagent.tool.failed', { toolName, error: 'Tool not found' });
        continue;
      }

      const permRequest = {
        toolName,
        input,
        cwd: ctx.cwd,
        dangerLevel: tool.dangerLevel || 'safe',
        sessionId: run.childSessionId,
        userId: 'default-subagent',
        permissionMode: run.permissionMode
      };

      const permResult = evaluatePermission(permRequest);

      // Block if denied OR requires manual user approval (since subagents cannot approve themselves!)
      if (permResult.decision === 'deny' || permResult.decision === 'ask' || tool.requiresApproval) {
        const reason = permResult.decision === 'ask' || tool.requiresApproval
          ? 'Subagents cannot solicit or resolve user approvals'
          : permResult.reason || 'Blocked by Permission Engine';

        ctx.writeTranscriptEvent(run.childSessionId, 'subagent.tool.failed', { toolName, error: `Access Denied: ${reason}` });
        ctx.writeAuditLog(run.childSessionId, 'subagent.tool.blocked', { toolName, input }, reason, 'failed');

        const blockMsg = {
          id: Math.random().toString(36).substring(7),
          role: 'system' as const,
          content: `<tool_response name="${toolName}">\nSecurity Error: Access Denied. ${reason}\n</tool_response>`,
          createdAt: new Date()
        };
        childSessionMessages.push(blockMsg);
        ctx.saveMessage(run.childSessionId, blockMsg);
        continue;
      }

      // Execute tool
      try {
        const toolCtx = {
          sessionId: run.childSessionId,
          userId: 'default-subagent',
          cwd: ctx.cwd,
          memoryAccess: null,
          auditLogger: null,
          approvalChecker: null
        };
        
        const result = await tool.run(input, toolCtx);

        const responseContent = `<tool_response name="${toolName}">\n${result.success ? result.output : 'Error: ' + result.error}\n</tool_response>`;
        const responseMsg = {
          id: Math.random().toString(36).substring(7),
          role: 'system' as const,
          content: responseContent,
          createdAt: new Date()
        };
        childSessionMessages.push(responseMsg);
        ctx.saveMessage(run.childSessionId, responseMsg);

        if (result.success) {
          ctx.writeTranscriptEvent(run.childSessionId, 'subagent.tool.finished', { toolName, output: result.output });
        } else {
          ctx.writeTranscriptEvent(run.childSessionId, 'subagent.tool.failed', { toolName, error: result.error });
          
          // --- SubagentToolFailed lifecycle hook ---
          const toolFailPayload = createHookEventPayload('SubagentToolFailed' as any, run.childSessionId, run.permissionMode, {
            toolName,
            toolInput: input,
            toolResult: result.error
          });
          await runHooks('SubagentToolFailed' as any, toolFailPayload);
        }
      } catch (err: any) {
        ctx.writeTranscriptEvent(run.childSessionId, 'subagent.tool.failed', { toolName, error: err.message });
      }
    } else {
      // Completed reasoning turn with no tool call
      continueLoop = false;
    }
  }

  // 3. Summarize findings into a structured result using model
  const summarizePrompt = `Please summarize all your research findings, work, and conclusions from the session above.
Provide your response strictly as a JSON object matching this schema:
{
  "summary": "High-level summary of your work",
  "findings": ["finding 1", "finding 2", ...],
  "artifacts": ["artifact description 1", ...],
  "nextActions": ["recommended next action 1", ...]
}`;

  let finalResult: SubagentResult = {
    summary: 'Subagent run executed',
    findings: [],
    artifacts: [],
    nextActions: []
  };

  try {
    const summaryResponse = await provider.generateText({
      messages: [...childSessionMessages, {
        id: Math.random().toString(36).substring(7),
        role: 'user',
        content: summarizePrompt,
        createdAt: new Date()
      }]
    });

    const jsonMatch = summaryResponse.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const data = JSON.parse(jsonMatch[0]);
      finalResult = SubagentResultSchema.parse(data);
    }
  } catch (err) {
    // Fallback: build a naive text summary
    const lastMsg = childSessionMessages[childSessionMessages.length - 1]?.content || '';
    finalResult = {
      summary: lastMsg.slice(0, 200),
      findings: [lastMsg.slice(0, 500)],
      artifacts: [],
      nextActions: []
    };
  }

  // --- SubagentComplete lifecycle hook ---
  const completePayload = createHookEventPayload('SubagentComplete' as any, run.childSessionId, run.permissionMode, {
    result: finalResult
  });
  await runHooks('SubagentComplete' as any, completePayload);

  // Write completed transcript and audit
  ctx.writeTranscriptEvent(run.parentSessionId, 'subagent.completed', { runId: run.id, result: finalResult });
  ctx.writeAuditLog(run.parentSessionId, 'subagent.run.completed', { runId: run.id }, 'Subagent run completed successfully', 'success');

  return finalResult;
}
