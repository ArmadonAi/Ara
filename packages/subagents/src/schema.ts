import { z } from 'zod';

export const SubagentProfileSchema = z.object({
  name: z.string().min(1, 'Profile name is required'),
  description: z.string().min(1, 'Profile description is required'),
  model: z.string().default('default'),
  permissionMode: z.enum(['plan', 'default', 'accept-edits', 'auto-safe', 'danger-review']),
  maxTurns: z.number().int().positive().default(8),
  tools: z.array(z.string()),
  tags: z.array(z.string()).default([]),
  systemPrompt: z.string().optional()
});

export const SubagentResultSchema = z.object({
  summary: z.string(),
  findings: z.array(z.string()),
  artifacts: z.array(z.string()),
  nextActions: z.array(z.string())
});
