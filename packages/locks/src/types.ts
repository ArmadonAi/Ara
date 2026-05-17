import { z } from 'zod';

export const LockModeSchema = z.enum(['read', 'write']);
export type LockMode = z.infer<typeof LockModeSchema>;

export const LockStatusSchema = z.enum(['active', 'released', 'expired', 'force_released']);
export type LockStatus = z.infer<typeof LockStatusSchema>;

export interface FileLock {
  id: string;
  workspaceId: string;
  sessionId: string;
  runId?: string;
  agentName?: string;
  path: string;
  realPath: string;
  mode: LockMode;
  status: LockStatus;
  reason: string;
  acquiredAt: string;
  expiresAt: string;
  releasedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface LockRequest {
  sessionId: string;
  path: string;
  mode: LockMode;
  runId?: string;
  agentName?: string;
  reason?: string;
  ttlMs?: number;
  metadata?: Record<string, unknown>;
}

export interface LockConflict {
  conflict: true;
  requestedLock: LockRequest;
  conflictingLocks: FileLock[];
  message: string;
}

export interface LockResult {
  ok: boolean;
  lock?: FileLock;
  conflict?: LockConflict;
  error?: string;
}

export interface LockFilter {
  sessionId?: string;
  runId?: string;
  path?: string;
  mode?: LockMode;
  status?: LockStatus;
  workspaceId?: string;
}
