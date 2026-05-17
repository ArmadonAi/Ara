import { z } from 'zod';
import type {
  MCPDiscoveredTool,
  MCPToolCall,
  MCPToolResult,
  MCPServerConfig,
} from './types';
import { MCPClient } from './mcpClient';
import { buildMCPAuditRecord, writeMCPAudit } from './mcpAudit';
import { runHooks, createHookEventPayload } from '@ara/hooks';
import { evaluatePermission } from '@ara/permissions';
import type { Tool, ToolContext, ToolResult } from '@ara/shared';

// ---------------------------------------------------------------------------
// MCPToolAdapter — wraps a discovered MCP tool as a native Ara Tool
// ---------------------------------------------------------------------------

export class MCPToolAdapter implements Tool {
  name: string;
  description: string;
  dangerLevel: 'safe' | 'write' | 'network' | 'dangerous';
  requiresApproval: boolean;
  inputSchema: z.ZodObject<any>;

  // Internal — not exposed to the agent
  readonly serverConfig: MCPServerConfig;
  readonly discoveredTool: MCPDiscoveredTool;
  readonly mcpClient: MCPClient;
  readonly sessionId: string;

  constructor(args: {
    serverConfig: MCPServerConfig;
    discoveredTool: MCPDiscoveredTool;
    mcpClient: MCPClient;
    sessionId: string;
  }) {
    this.serverConfig = args.serverConfig;
    this.discoveredTool = args.discoveredTool;
    this.mcpClient = args.mcpClient;
    this.sessionId = args.sessionId;

    const toolName = `mcp.${this.serverConfig.id}.${this.discoveredTool.name}`;
    this.name = toolName;
    this.description = `[MCP / ${this.serverConfig.name}] ${this.discoveredTool.description}`;
    this.dangerLevel = this.discoveredTool.dangerLevel;
    this.requiresApproval = this.dangerLevel === 'write' || this.dangerLevel === 'dangerous';

    // Build a flexible input schema from the MCP tool's declared inputSchema
    try {
      const rawSchema = this.discoveredTool.inputSchema;
      this.inputSchema = rawSchemaToZod(rawSchema);
      if (this.inputSchema instanceof z.ZodError) {
        // Fallback to wildcard
        this.inputSchema = z.object({ _input: z.any() });
      }
    } catch {
      this.inputSchema = z.object({ _input: z.any() });
    }
  }

  async run(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const startedAt = new Date().toISOString();
    const toolNameFull = this.name;
    const fullToolName = toolNameFull;

    try {
      // --- Permission Engine evaluation ---
      const permResult = evaluatePermission({
        toolName: fullToolName,
        input: input as Record<string, unknown>,
        cwd: ctx.cwd,
        dangerLevel: this.dangerLevel,
        sessionId: this.sessionId,
        permissionMode: this.serverConfig.permissionMode as any,
      });

      // Block — permission engine says no
      if (permResult.decision === 'deny' || permResult.blocked) {
        const error = `[MCP BLOCKED] ${permResult.reason}`;
        const record = buildMCPAuditRecord({
          eventType: 'mcp.tool.denied',
          serverId: this.serverConfig.id,
          serverName: this.serverConfig.name,
          sessionId: this.sessionId,
          toolName: this.discoveredTool.name,
          fullToolName,
          input: input as Record<string, unknown>,
          permissionDecision: 'deny',
          startedAt,
        });
        writeMCPAudit(record);

        // Hooks
        runHooks('ToolFailed', createHookEventPayload('ToolFailed', this.sessionId, ctx.permissionMode, {
          toolName: fullToolName,
          reason: permResult.reason,
        })).catch(() => {});

        return { success: false, output: '', error };
      }

      // Ask — needs approval gate
      if (permResult.decision === 'ask' || permResult.requiresApproval) {
        if (this.dangerLevel === 'write' || this.dangerLevel === 'dangerous') {
          try {
            const ckptMod = await import('@ara/checkpoints');
            const cpResult = ckptMod.createCheckpoint
              ? await ckptMod.createCheckpoint(
                  this.sessionId,
                  ctx.cwd,
                  `before_mcp_${this.discoveredTool.name}`,
                  { createdBy: 'system' }
                )
              : null;
            // The checkpoint is created before the approval gate; result is managed by the checkpoint system.
            void cpResult;
          } catch {
            // checkpoint module not available — don't block the tool
          }
        }

        return {
          success: false,
          output: '',
          error: `[MCP AWAITING APPROVAL] ${this.name} — ${permResult.reason} — Run 'ara approve <id>' to authorize.}`,
        };
      }

      // --- PreToolUse hook ---
      await runHooks('PreToolUse', createHookEventPayload('PreToolUse', this.sessionId, ctx.permissionMode, {
        toolName: fullToolName,
        toolInput: input as Record<string, unknown>,
      })).catch(() => {});

      // --- Make the MCP call ---
      const call: MCPToolCall = {
        serverId: this.serverConfig.id,
        toolName: this.discoveredTool.name,
        input: (input || {}) as Record<string, unknown>,
        sessionId: this.sessionId,
      };

      const mcpResult: MCPToolResult = await this.mcpClient.callTool(call);

      // --- PostToolUse / ToolFailed hooks ---
      if (mcpResult.ok) {
        await runHooks('PostToolUse', createHookEventPayload('PostToolUse', this.sessionId, ctx.permissionMode, {
          toolName: fullToolName,
          toolResult: { ok: true, outputSummary: mcpResult.outputSummary },
        })).catch(() => {});
      } else {
        await runHooks('ToolFailed', createHookEventPayload('ToolFailed', this.sessionId, ctx.permissionMode, {
          toolName: fullToolName,
          reason: mcpResult.error || 'MCP tool execution failed',
        })).catch(() => {});
      }

      // --- Audit log ---
      const record = buildMCPAuditRecord({
        eventType: mcpResult.ok ? 'mcp.tool.called' : 'mcp.tool.failed',
        serverId: this.serverConfig.id,
        serverName: this.serverConfig.name,
        sessionId: this.sessionId,
        toolName: this.discoveredTool.name,
        fullToolName,
        input: input as Record<string, unknown>,
        result: mcpResult,
        permissionDecision: permResult.decision,
        startedAt,
        durationMs: mcpResult.durationMs,
        dangerLevel: this.dangerLevel,
      });
      writeMCPAudit(record);

      return {
        success: mcpResult.ok,
        output: mcpResult.content || mcpResult.outputSummary,
        error: mcpResult.error,
      };
    } catch (e: any) {
      writeMCPAudit(
        buildMCPAuditRecord({
          eventType: 'mcp.tool.failed',
          serverId: this.serverConfig.id,
          serverName: this.serverConfig.name,
          sessionId: this.sessionId,
          toolName: this.discoveredTool.name,
          fullToolName,
          startedAt,
          error: redactSecret(e.message),
        })
      );
      return { success: false, output: '', error: redactSecret(e.message) };
    }
  }
}

// ---------------------------------------------------------------------------
// Factory — given a server config and discovered tools, produce Ara adapter tools
// ---------------------------------------------------------------------------
export function adaptDiscoveredTools(
  serverConfig: MCPServerConfig,
  discoveredTools: MCPDiscoveredTool[],
  mcpClient: MCPClient,
  sessionId: string
): Tool[] {
  return discoveredTools.map(t => new MCPToolAdapter({ serverConfig, discoveredTool: t, mcpClient, sessionId }));
}

// ---------------------------------------------------------------------------
// Schema helper — convert a JSON Schema fragment to a Zod object
// ---------------------------------------------------------------------------
function rawSchemaToZod(
  schema: Record<string, unknown>
): z.ZodObject<z.ZodRawShape> | z.ZodAny {
  try {
    if (schema.properties && typeof schema.properties === 'object') {
      const shape: z.ZodRawShape = {};
      const props = schema.properties as Record<string, unknown>;
      for (const [key, val] of Object.entries(props)) {
        shape[key] = fragmentToZod(val);
      }
      return z.object(shape);
    }
    if (schema.type === 'string') return z.string();
    if (schema.type === 'number') return z.number();
    if (schema.type === 'integer') return z.number().int();
    if (schema.type === 'boolean') return z.boolean();
    if (schema.type === 'array') return z.array(fragmentToZod(schema.items || {}));
    if (schema.type === 'object') return z.object({});
  } catch {}
  return z.any();
}

function fragmentToZod(fragment: Record<string, unknown>): z.ZodTypeAny {
  try {
    if (fragment.type === 'string') return z.string();
    if (fragment.type === 'number') return z.number();
    if (fragment.type === 'integer') return z.number().int();
    if (fragment.type === 'boolean') return z.boolean();
    if (fragment.type === 'array') {
      const items = (fragment as any).items;
      return z.array(fragmentToZod(items || { type: 'string' }));
    }
    if (fragment.type === 'object') return z.record(z.unknown());
  } catch {}
  return z.any();
}

// --------------- helpers ---------------

function redactSecret(str: string): string {
  return str
    .replace(/sk-[a-zA-Z0-9]{32,}/g, '[REDACTED]')
    .replace(/AIza[0-9A-Za-z-_]{35}/g, '[REDACTED]')
    .replace(/ghp_[a-zA-Z0-9]{36,}/g, '[REDACTED]')
    .replace(/glpat-[a-zA-Z0-9\-_]{20,}/g, '[REDACTED]');
}
