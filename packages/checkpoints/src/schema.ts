import { z } from 'zod';

export const CheckpointFileSnapshotSchema = z.object({
  path: z.string(),
  absolutePath: z.string(),
  existsBefore: z.boolean(),
  contentHashBefore: z.string().optional(),
  contentBefore: z.string().optional(),
  sizeBytes: z.number(),
  isBinary: z.boolean(),
  isLarge: z.boolean(),
  skipped: z.boolean(),
  skipReason: z.string().optional(),
});

export const SessionSnapshotSchema = z.object({
  sessionId: z.string(),
  messageIds: z.array(z.string()),
  messageCount: z.number(),
  activeModel: z.string(),
  permissionMode: z.string(),
  compactDigest: z.string().optional(),
  transcriptSeq: z.number(),
  pendingApprovalIds: z.array(z.string()),
  createdAt: z.string(),
});

export const CheckpointSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  cwd: z.string(),
  reason: z.string(),
  createdAt: z.string(),
  createdBy: z.enum(['agent', 'user', 'hook', 'system']),
  beforeToolName: z.string().optional(),
  beforeToolInput: z.string().optional(),
  transcriptSeq: z.number(),
  messageCount: z.number(),
  gitHead: z.string().optional(),
  files: z.array(CheckpointFileSnapshotSchema),
  sessionSnapshot: SessionSnapshotSchema,
  metadata: z.record(z.string(), z.any()).optional(),
});

export const CheckpointRestoreModeSchema = z.enum(['code_only', 'conversation_only', 'both']);
