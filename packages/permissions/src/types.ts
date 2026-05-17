export type PermissionDecision = 'allow' | 'ask' | 'deny';

export interface PermissionRule {
  id: string;
  effect: PermissionDecision;
  toolName?: string;
  pathGlob?: string;
  commandPattern?: string;
  domainPattern?: string;
  reason?: string;
}

export type PermissionMode = 'plan' | 'default' | 'accept-edits' | 'auto-safe' | 'danger-review';

export interface PermissionRequest {
  toolName: string;
  input: any;
  cwd: string;
  dangerLevel: string;
  sessionId?: string;
  userId?: string;
  permissionMode: PermissionMode;
}

export interface PermissionResult {
  decision: PermissionDecision;
  matchedRuleId?: string;
  reason: string;
  requiresApproval: boolean;
  blocked: boolean;
}
