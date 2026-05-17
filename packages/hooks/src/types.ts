import type { PermissionMode } from '@ara/permissions';

export type HookEventName =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'ToolFailed'
  | 'ApprovalRequested'
  | 'ApprovalResolved'
  | 'Stop'
  | 'CheckpointCreated'
  | 'SessionEnd'
  // MCP lifecycle events
  | 'MCPServerStart'
  | 'MCPServerStop'
  | 'MCPToolDiscovered'
  | 'MCPToolCallStart'
  | 'MCPToolCallEnd'
  | 'MCPToolCallFailed'
  // GitHub lifecycle events
  | 'GitHubActionStart'
  | 'GitHubActionEnd'
  | 'GitHubActionFailed'
  | 'GitHubWriteApprovalRequested'
  // Lock and parallel subagent events
  | 'LockAcquired'
  | 'LockReleased'
  | 'LockConflict'
  | 'LockExpired'
  | 'ParallelSubagentsStart'
  | 'ParallelSubagentsComplete'
  | 'ParallelSubagentsFailed';

export interface HookEventPayload {
  event: HookEventName;
  sessionId: string;
  timestamp: string;
  cwd: string;
  permissionMode: PermissionMode;
  toolName?: string;
  toolInput?: any;
  toolResult?: any;
  approvalId?: string;
  userPrompt?: string;
  metadata?: Record<string, any>;
}

export type HookType = 'command' | 'http';

export interface BaseHookConfig {
  name: string;
  type: HookType;
  matcher?: string; // matches toolName or similar pattern
  timeoutMs?: number;
}

export interface CommandHookConfig extends BaseHookConfig {
  type: 'command';
  command: string;
}

export interface HttpHookConfig extends BaseHookConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}

export type HookConfig = CommandHookConfig | HttpHookConfig;

export type HookDecision = 'continue' | 'block' | 'warn';

export interface HookResult {
  decision: HookDecision;
  reason?: string;
}

export interface HookAuditRecord {
  id: string;
  sessionId: string;
  event: HookEventName;
  hookName: string;
  hookType: HookType;
  matcher?: string;
  commandOrUrl: string;
  status: 'success' | 'failed';
  decision: HookDecision;
  reason?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs: number;
  outputSummary?: string;
  error?: string;
}
