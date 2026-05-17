import type { SubagentProfile, SubagentRun } from './types';
import type { PermissionMode } from '@ara/permissions';

export function createSubagentRun(
  parentSessionId: string,
  profile: SubagentProfile,
  task: string,
  context: string,
  options?: {
    allowedTools?: string[];
    permissionMode?: PermissionMode;
    maxTurns?: number;
  }
): SubagentRun {
  // Intersection of requested allowedTools and profile tools
  let finalAllowedTools = [...profile.tools];
  if (options?.allowedTools) {
    finalAllowedTools = finalAllowedTools.filter(t => options.allowedTools!.includes(t));
  }

  const runId = Math.random().toString(36).substring(7);
  const childSessionId = `sub-${Math.random().toString(36).substring(7)}`;

  return {
    id: runId,
    parentSessionId,
    childSessionId,
    profileName: profile.name,
    task,
    context,
    allowedTools: finalAllowedTools,
    permissionMode: options?.permissionMode || profile.permissionMode || 'plan',
    status: 'pending',
    maxTurns: options?.maxTurns || profile.maxTurns || 8,
    createdAt: new Date()
  };
}
