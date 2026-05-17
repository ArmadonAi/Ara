import type { ChatSession, Message, LLMProvider, ChatChunk } from '@ara/shared';
import { ToolRegistry } from '@ara/tools';
import type { MemoryStore } from '@ara/memory';
import type { SkillLoader } from '@ara/skills';
import { ModelRouter } from '@ara/model-router';
import { evaluatePermission, type PermissionMode } from '@ara/permissions';
import { runHooks, createHookEventPayload } from '@ara/hooks';
import { createCheckpoint, shouldCreateCheckpointBeforeTool } from '@ara/checkpoints';

export class AgentRuntime {
  public permissionMode: PermissionMode = 'default';

  constructor(
    public modelRouter: ModelRouter,
    public toolRegistry: ToolRegistry,
    public memoryStore: MemoryStore,
    public skillLoader: SkillLoader
  ) {}

  async createSession(model: string, title: string = 'New Conversation'): Promise<ChatSession> {
    return {
      id: Math.random().toString(36).substring(7),
      title,
      messages: [],
      model,
      createdAt: new Date(),
      updatedAt: new Date()
    };
  }

  async *streamAgentLoop(
    session: ChatSession,
    userInput: string,
    options?: { onAuditLog?: (log: { toolName: string; input: any; outputSummary: string; status: 'success' | 'failed' }) => void }
  ): AsyncGenerator<ChatChunk, void, unknown> {
    // --- SessionStart hook ---
    if (session.messages.length === 0) {
      const startPayload = createHookEventPayload('SessionStart', session.id, this.permissionMode);
      const startRes = await runHooks('SessionStart', startPayload);
      if (startRes.decision === 'block') {
        yield { text: `\n🚫 [Session Start Blocked]: ${startRes.reason}`, isFinished: true };
        return;
      }
    }

    // 1. Add user message
    if (userInput) {
      const userMsg: Message = {
        id: Math.random().toString(36).substring(7),
        role: 'user',
        content: userInput,
        createdAt: new Date()
      };
      session.messages.push(userMsg);
      session.updatedAt = new Date();

      // --- UserPromptSubmit hook ---
      const promptPayload = createHookEventPayload('UserPromptSubmit', session.id, this.permissionMode, {
        userPrompt: userInput
      });
      const promptRes = await runHooks('UserPromptSubmit', promptPayload);
      if (promptRes.decision === 'block') {
        yield { text: `\n🚫 [Prompt Blocked by Hook]: ${promptRes.reason}`, isFinished: true };
        return;
      }
    }

    const provider = this.modelRouter.get(session.model);
    if (!provider) {
      throw new Error(`Provider not found for model: ${session.model}`);
    }

    // List registered tools dynamically
    const toolsDescription = this.toolRegistry.list().map(t => 
      `- **${t.name}**: ${t.description} (Danger Level: ${t.dangerLevel}, Requires Approval: ${t.requiresApproval})`
    ).join('\n');

    // Fetch and build memory context dynamically from USER.md and MEMORY.md
    const memories = await this.memoryStore.search('', undefined);
    const userFacts = memories.filter(m => m.type === 'user').map(m => `- ${m.content}`).join('\n');
    const episodicFacts = memories.filter(m => m.type === 'episodic').map(m => `- ${m.content}`).join('\n');

    // Fetch and build skills procedures context dynamically from SKILL.md files
    const rawSkills = await this.skillLoader.listSkills();
    const fullSkills = [];
    for (const rs of rawSkills) {
      const fsDetail = await this.skillLoader.loadSkill(rs.name);
      if (fsDetail) {
        fullSkills.push(fsDetail);
      }
    }
    const skillsProcedures = fullSkills.map(s => `
[Skill: ${s.name}]
Description: ${s.description}
Procedure Steps to follow if this skill is requested:
${s.procedure.map((step, idx) => `  ${idx + 1}. ${step}`).join('\n')}
`).join('\n');

    const systemPrompt = `You are Ara, a Personal AI Assistant running inside a local-first personal control plane.
You help the user think, plan, code, automate, research, and operate their digital work.

Available Tools:
${toolsDescription}

Tool Calling Rules:
1. To call a tool, output a block in the following XML format:
<tool_call name="tool_name">
{
  "parameter_name": "value"
}
</tool_call>
2. You can call one tool per turn.
3. If you decide to call a tool, do NOT output anything after the </tool_call> tag. Let the user run the tool first.
4. After a tool runs, you will receive a <tool_response> in the next turn and can continue your reasoning or output final answers.

User Profile Facts (from USER.md):
${userFacts || '- No profile facts saved yet.'}

Long-term & Episodic Memory (from MEMORY.md):
${episodicFacts || '- No episodic memory saved yet.'}

System Skills & Procedures (from SKILL.md files):
${skillsProcedures || '- No dynamic skills loaded.'}

General Guidelines:
1. Follow the user's explicit instructions first.
2. Before risky actions (Danger Level "write" or "dangerous"), explain why the tool is necessary.
3. Never expose or store secrets.
4. Keep responses concise but complete.`;

    let continueLoop = true;

    while (continueLoop) {
      let completeResponse = '';
      
      for await (const chunk of provider.streamChat({
        messages: session.messages,
        systemPrompt
      })) {
        completeResponse += chunk.text;
        yield chunk;
      }

      // Check if LLM requested a tool call in its response
      const toolCallRegex = /<tool_call\s+name="([^"]+)"\s*>([\s\S]+?)<\/tool_call>/i;
      const match = completeResponse.match(toolCallRegex);

      if (match) {
        const toolName = match[1]?.trim() || '';
        const rawInput = match[2]?.trim() || '{}';
        
        // Parse input JSON safely
        let input: any = {};
        try {
          input = JSON.parse(rawInput);
        } catch (e) {
          yield { text: `\n[System Error: Invalid JSON input for tool ${toolName}]`, isFinished: true };
          break;
        }

        const tool = this.toolRegistry.get(toolName);
        if (!tool) {
          yield { text: `\n[System Error: Tool "${toolName}" not found]`, isFinished: true };
          break;
        }

        // Save assistant tool-call message to session history
        const assistantMsg: Message = {
          id: Math.random().toString(36).substring(7),
          role: 'assistant',
          content: completeResponse,
          createdAt: new Date()
        };
        session.messages.push(assistantMsg);

        // --- PreToolUse hook ---
        const preToolPayload = createHookEventPayload('PreToolUse', session.id, this.permissionMode, {
          toolName,
          toolInput: input
        });
        const hookResult = await runHooks('PreToolUse', preToolPayload);
        if (hookResult.decision === 'block') {
          yield {
            text: `\n🚫 [Tool Blocked by Hook]: ${hookResult.reason}`,
            isFinished: true,
            blockedToolCall: {
              toolName,
              reason: hookResult.reason || 'Blocked by custom lifecycle hook'
            }
          };

          const systemMsg: Message = {
            id: Math.random().toString(36).substring(7),
            role: 'system',
            content: `<tool_response name="${toolName}">\nError: Blocked by Hook. ${hookResult.reason}\n</tool_response>`,
            createdAt: new Date()
          };
          session.messages.push(systemMsg);

          if (options?.onAuditLog) {
            options.onAuditLog({
              toolName,
              input,
              outputSummary: `Blocked by Hook: ${hookResult.reason}`,
              status: 'failed'
            });
          }
          continueLoop = false;
          break;
        }

        // --- PHASE 11: PERMISSION ENGINE INTEGRATION ---
        const permRequest = {
          toolName,
          input,
          cwd: process.cwd(),
          dangerLevel: tool.dangerLevel || 'safe',
          sessionId: session.id,
          userId: 'default-user',
          permissionMode: this.permissionMode
        };

        const permResult = evaluatePermission(permRequest);

        if (permResult.decision === 'deny') {
          // 4. Deny: block agent execution, append security error, yield blocked status
          yield {
            text: `\n🛡️ [Security Block]: ${permResult.reason}`,
            isFinished: false
          };

          const systemMsg: Message = {
            id: Math.random().toString(36).substring(7),
            role: 'system',
            content: `<tool_response name="${toolName}">\nSecurity Error: Access Denied. ${permResult.reason}\n</tool_response>`,
            createdAt: new Date()
          };
          session.messages.push(systemMsg);

          // Write blocked attempt to audit log if callback is present
          if (options?.onAuditLog) {
            options.onAuditLog({
              toolName,
              input,
              outputSummary: `Security Block: ${permResult.reason}`,
              status: 'failed'
            });
          }

          yield {
            text: `\n[System Blocked Tool: ${toolName}]`,
            isFinished: true,
            blockedToolCall: {
              toolName,
              reason: permResult.reason
            }
          };

          continueLoop = false;
          break;
        }

        if (permResult.decision === 'ask' || tool.requiresApproval) {
          // 5. Ask: Standard requiresApproval workflow (yield awaiting approval, pause loop)
          yield {
            text: `\n[Awaiting user approval to run tool "${toolName}"...]`,
            isFinished: true,
            awaitingApproval: {
              toolName,
              input,
              dangerLevel: tool.dangerLevel,
              reason: permResult.reason || `Agent requested to run tool: ${toolName}`
            }
          };
          continueLoop = false;
        } else {
          // 6. Allow: Execute safe tool immediately!
          yield { text: `\n[⚙️ Running tool: ${toolName}...]\n`, isFinished: false };

          const ctx = {
            sessionId: session.id,
            userId: 'default-user',
            cwd: process.cwd(),
            memoryAccess: null,
            auditLogger: null,
            approvalChecker: null
          };

          // Automatically create a checkpoint before executing a mutating tool!
          if (shouldCreateCheckpointBeforeTool(toolName, input)) {
            try {
              await createCheckpoint(session.id, process.cwd(), `Automatically created before running tool: ${toolName}`, {
                createdBy: 'agent',
                beforeToolName: toolName,
                beforeToolInput: JSON.stringify(input)
              });
            } catch (err) {
              // Fail silently to keep execution moving
            }
          }

          const result = await tool.run(input, ctx);

          // Append tool response as system message to history
          const systemMsg: Message = {
            id: Math.random().toString(36).substring(7),
            role: 'system',
            content: `<tool_response name="${toolName}">\n${result.success ? result.output : 'Error: ' + result.error}\n</tool_response>`,
            createdAt: new Date()
          };
          session.messages.push(systemMsg);

          // --- PostToolUse / ToolFailed hooks ---
          if (result.success) {
            const postPayload = createHookEventPayload('PostToolUse', session.id, this.permissionMode, {
              toolName,
              toolInput: input,
              toolResult: result.output
            });
            await runHooks('PostToolUse', postPayload);
          } else {
            const failPayload = createHookEventPayload('ToolFailed', session.id, this.permissionMode, {
              toolName,
              toolInput: input,
              toolResult: result.error || 'Unknown tool failure'
            });
            await runHooks('ToolFailed', failPayload);
          }

          // 7. Write safe execution attempt to audit log if callback is present
          if (options?.onAuditLog) {
            options.onAuditLog({
              toolName,
              input,
              outputSummary: result.success ? result.output : result.error || 'Unknown error',
              status: result.success ? 'success' : 'failed'
            });
          }
          
          yield { text: `[Tool Output Success: ${result.success}]\n`, isFinished: false };
        }
      } else {
        // No tool calls requested, save assistant message and terminate loop
        const assistantMsg: Message = {
          id: Math.random().toString(36).substring(7),
          role: 'assistant',
          content: completeResponse,
          createdAt: new Date()
        };
        session.messages.push(assistantMsg);
        session.updatedAt = new Date();
        continueLoop = false;
      }
    }

    // --- SessionEnd hook ---
    const endPayload = createHookEventPayload('SessionEnd', session.id, this.permissionMode);
    await runHooks('SessionEnd', endPayload);
  }

  async runAgentLoop(session: ChatSession, userInput: string): Promise<string> {
    let result = '';
    for await (const chunk of this.streamAgentLoop(session, userInput)) {
      result += chunk.text;
    }
    return result;
  }
}
