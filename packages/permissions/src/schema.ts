import { z } from 'zod';

export const PermissionDecisionSchema = z.enum(['allow', 'ask', 'deny']);

export const PermissionRuleSchema = z.object({
  id: z.string(),
  effect: PermissionDecisionSchema,
  toolName: z.string().optional(),
  pathGlob: z.string().optional(),
  commandPattern: z.string().optional(),
  domainPattern: z.string().optional(),
  reason: z.string().optional(),
});

export const PermissionModeSchema = z.enum(['plan', 'default', 'accept-edits', 'auto-safe', 'danger-review']);

export const PermissionRequestSchema = z.object({
  toolName: z.string(),
  input: z.any(),
  cwd: z.string(),
  dangerLevel: z.string(),
  sessionId: z.string().optional(),
  userId: z.string().optional(),
  permissionMode: PermissionModeSchema,
});

export const PermissionResultSchema = z.object({
  decision: PermissionDecisionSchema,
  matchedRuleId: z.string().optional(),
  reason: z.string(),
  requiresApproval: z.boolean(),
  blocked: z.boolean(),
});
