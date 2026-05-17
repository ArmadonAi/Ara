import { z } from 'zod';
import { LockModeSchema, LockStatusSchema } from './types';

export const LockRequestSchema = z.object({
  sessionId: z.string().min(1),
  path: z.string().min(1),
  mode: LockModeSchema,
  runId: z.string().optional(),
  agentName: z.string().optional(),
  reason: z.string().optional(),
  ttlMs: z.number().int().positive().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const ForceReleaseSchema = z.object({
  reason: z.string().min(1, 'Reason is required for force release'),
});

export const LockQuerySchema = z.object({
  sessionId: z.string().optional(),
  runId: z.string().optional(),
  path: z.string().optional(),
  mode: LockModeSchema.optional(),
  status: LockStatusSchema.optional(),
});
