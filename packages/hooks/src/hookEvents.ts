import type { HookEventName, HookEventPayload } from './types';
import type { PermissionMode } from '@ara/permissions';

export function createHookEventPayload(
  event: HookEventName,
  sessionId: string,
  permissionMode: PermissionMode,
  options?: {
    toolName?: string;
    toolInput?: any;
    toolResult?: any;
    approvalId?: string;
    userPrompt?: string;
    metadata?: Record<string, any>;
    cwd?: string;
  }
): HookEventPayload {
  return {
    event,
    sessionId,
    timestamp: new Date().toISOString(),
    cwd: options?.cwd || process.cwd(),
    permissionMode,
    toolName: options?.toolName,
    toolInput: options?.toolInput,
    toolResult: options?.toolResult,
    approvalId: options?.approvalId,
    userPrompt: options?.userPrompt,
    metadata: options?.metadata
  };
}
