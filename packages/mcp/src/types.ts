import { z } from 'zod';

// --- Server transport types ---
export const MCPServerTypeSchema = z.enum(['stdio', 'http']);
export type MCPServerType = z.infer<typeof MCPServerTypeSchema>;

// --- Server health states ---
export const MCPServerStateSchema = z.enum([
  'disabled',
  'starting',
  'healthy',
  'degraded',
  'unhealthy',
  'stopped',
  'error',
]);
export type MCPServerState = z.infer<typeof MCPServerStateSchema>;

// --- MCP server config (loaded from .ara/mcp.json) ---
export const MCPToolFilterSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  mutating: z.boolean().optional().default(false),
});
export type MCPToolFilter = z.infer<typeof MCPToolFilterSchema>;

export const MCPServerConfigSchema = z.object({
  id: z.string().min(1, 'Server id must not be empty'),
  name: z.string().min(1, 'Server name must not be empty'),
  type: MCPServerTypeSchema,
  // stdio transport fields
  command: z.string().optional(),
  args: z.array(z.string()).optional().default([]),
  cwd: z.string().optional().default('.'),
  // HTTP transport fields
  url: z.string().url().optional(),
  headers: z.record(z.string()).optional().default({}),
  // Security & operational fields
  enabled: z.boolean().default(true),
  trusted: z.boolean().default(false),
  permissionMode: z
    .enum(['plan', 'default', 'accept-edits', 'auto-safe', 'danger-review'])
    .default('default'),
  allowedTools: z.array(z.string()).default([]),
  deniedTools: z.array(z.string()).default([]),
  toolFilters: z.array(MCPToolFilterSchema).optional().default([]),
  env: z.record(z.string()).optional().default({}),
  timeoutMs: z.number().int().positive().optional().default(15_000),
});

export type MCPServerConfig = z.infer<typeof MCPServerConfigSchema>;

export const MCPConfigSchema = z.object({
  servers: z.array(MCPServerConfigSchema).default([]),
});
export type MCPConfig = z.infer<typeof MCPConfigSchema>;

// --- Discovered tool ---
export interface MCPDiscoveredTool {
  serverId: string;
  serverName: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  dangerLevel: 'safe' | 'write' | 'network' | 'dangerous';
  mutating: boolean;
}

// --- Tool call ---
export interface MCPToolCall {
  serverId: string;
  toolName: string;
  input: Record<string, unknown>;
  sessionId: string;
  parentToolCallId?: string;
}

// --- Tool result ---
export interface MCPToolResult {
  ok: boolean;
  content: string;
  outputSummary: string;
  rawResponse?: Record<string, unknown>;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
}

// --- Permission mapping ---
export interface MCPPermissionInput {
  serverConfig: MCPServerConfig;
  tool: MCPDiscoveredTool;
  input: Record<string, unknown>;
  permissionMode: string;
  trustLevel: 'trusted' | 'untrusted';
}

export interface MCPPermissionOutput {
  decision: 'allow' | 'ask' | 'deny';
  dangerLevel: 'safe' | 'write' | 'network' | 'dangerous';
  requiresApproval: boolean;
  reason: string;
}

// --- Audit ---
export interface MCPAuditRecord {
  id: string;
  sessionId: string;
  eventType:
    | 'mcp.server.started'
    | 'mcp.server.stopped'
    | 'mcp.server.failed'
    | 'mcp.tool.discovered'
    | 'mcp.tool.called'
    | 'mcp.tool.denied'
    | 'mcp.tool.failed';
  serverId: string;
  serverName: string;
  toolName?: string;
  fullToolName?: string;
  inputSummary?: string;
  outputSummary?: string;
  error?: string;
  status: 'success' | 'failed';
  dangerLevel?: string;
  permissionDecision?: string;
  approvalId?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  redactedRawResponse?: Record<string, unknown>;
}

// --- Health check ---
export interface MCPHealthStatus {
  serverId: string;
  state: MCPServerState;
  lastError?: string;
  lastCheckedAt: string;
  uptimeMs?: number;
  toolCount: number;
  lastPingAt?: string;
  lastPingLatency?: number;
}
