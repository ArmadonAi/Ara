import type { FileLock, LockRequest, LockResult, LockConflict, LockFilter, LockMode } from './types';
import { addLock, updateLockStatus, findLock, queryLocks, getActiveLocks, removeLock } from './lockStore';
import { normalizePath, resolveRealPath, isPathInWorkspace, pathsConflict } from './pathLocking';
import { writeLockAudit } from './lockAudit';
import { detectDeadlock } from './deadlockDetection';

const DEFAULT_TTL_MS = 30_000; // 30 seconds
const DEFAULT_WAIT_TIMEOUT_MS = 10_000; // 10 seconds max wait
const WORKSPACE_ID = process.cwd();

let lockCounter = 0;

function generateLockId(): string {
  lockCounter++;
  return `lock-${Date.now()}-${lockCounter}`;
}

/**
 * Detect conflicts for a requested lock against all active locks.
 */
export function detectConflicts(request: LockRequest): LockConflict | null {
  const realPath = resolveRealPath(normalizePath(request.path));
  const active = getActiveLocks();

  const conflicting = active.filter(existing => {
    // Same path conflict check
    if (!pathsConflict(realPath, existing.realPath)) return false;
    // Same session locks don't conflict with themselves
    if (existing.sessionId === request.sessionId &&
        (!existing.runId || !request.runId || existing.runId === request.runId)) return false;
    // Read locks don't conflict with read locks
    if (existing.mode === 'read' && request.mode === 'read') return false;
    // Write lock conflicts with everything
    if (existing.mode === 'write' || request.mode === 'write') return true;
    return false;
  });

  if (conflicting.length > 0) {
    return {
      conflict: true,
      requestedLock: request,
      conflictingLocks: conflicting,
      message: `Lock conflict on "${request.path}": ${conflicting.length} existing lock(s) block this request. ` +
        `Owner(s): ${conflicting.map(l => `${l.agentName || l.sessionId} (${l.mode})`).join(', ')}`,
    };
  }

  return null;
}

/**
 * Acquire a lock on a file path with deadlock detection and stale cleanup.
 */
export function acquireLock(request: LockRequest): LockResult {
  const ws = WORKSPACE_ID;
  const reqPath = normalizePath(request.path);

  // Must be within workspace
  if (!isPathInWorkspace(reqPath, ws)) {
    writeLockAudit('lock.acquire_requested', {
      sessionId: request.sessionId, runId: request.runId, path: request.path,
      mode: request.mode, reason: 'Path outside workspace',
    });
    return { ok: false, error: `Path "${request.path}" is outside the workspace` };
  }

  // 1. Clean up stale locks before acquire
  cleanupExpiredLocks();

  const realPath = resolveRealPath(reqPath);
  const ttlMs = request.ttlMs || DEFAULT_TTL_MS;

  // 2. Check for conflicts
  const conflict = detectConflicts(request);
  if (conflict) {
    // 3. Run deadlock detection
    const deadlock = detectDeadlock(request);
    if (deadlock.deadlock) {
      writeLockAudit('lock.deadlock_detected', {
        sessionId: request.sessionId, runId: request.runId, path: reqPath,
        mode: request.mode, reason: deadlock.message,
        metadata: { cycle: deadlock.cycle },
      });
      return {
        ok: false,
        error: `[DEADLOCK] ${deadlock.message}. Try again after current operations complete.`,
      };
    }

    writeLockAudit('lock.conflict', {
      sessionId: request.sessionId, runId: request.runId, path: reqPath,
      mode: request.mode, reason: conflict.message,
      metadata: { conflictingLocks: conflict.conflictingLocks.map(l => l.id) },
    });
    return { ok: false, conflict, error: conflict.message };
  }

  // Create the lock
  const lock: FileLock = {
    id: generateLockId(),
    workspaceId: ws,
    sessionId: request.sessionId,
    runId: request.runId,
    agentName: request.agentName,
    path: reqPath,
    realPath,
    mode: request.mode,
    status: 'active',
    reason: request.reason || 'No reason provided',
    acquiredAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    metadata: request.metadata,
  };

  addLock(lock);
  writeLockAudit('lock.acquired', {
    sessionId: lock.sessionId, runId: lock.runId, path: lock.path,
    lockId: lock.id, mode: lock.mode, reason: lock.reason,
  });

  return { ok: true, lock };
}

/**
 * Acquire multiple locks atomically (all or nothing).
 */
export function acquireMany(requests: LockRequest[]): LockResult[] {
  const acquired: string[] = [];
  const results: LockResult[] = [];

  for (const req of requests) {
    const result = acquireLock(req);
    results.push(result);
    if (result.ok && result.lock) {
      acquired.push(result.lock.id);
    } else {
      // Rollback all acquired locks
      for (const id of acquired) {
        releaseLock(id);
      }
      return results;
    }
  }

  return results;
}

/**
 * Release a lock by ID.
 */
export function releaseLock(id: string): LockResult {
  const lock = findLock(id);
  if (!lock) return { ok: false, error: `Lock "${id}" not found` };
  if (lock.status !== 'active') return { ok: false, error: `Lock "${id}" is already ${lock.status}` };

  updateLockStatus(id, 'released', new Date().toISOString());
  writeLockAudit('lock.released', {
    sessionId: lock.sessionId, runId: lock.runId, path: lock.path,
    lockId: id, mode: lock.mode,
  });

  return { ok: true, lock: { ...lock, status: 'released' } };
}

/**
 * Force-release a lock with a reason.
 */
export function forceReleaseLock(id: string, reason: string): LockResult {
  const lock = findLock(id);
  if (!lock) return { ok: false, error: `Lock "${id}" not found` };

  const old = { ...lock };
  updateLockStatus(id, 'force_released', new Date().toISOString());
  writeLockAudit('lock.force_released', {
    sessionId: lock.sessionId, runId: lock.runId, path: lock.path,
    lockId: id, mode: lock.mode, reason,
  });

  return { ok: true, lock: { ...old, status: 'force_released' as const } };
}

/**
 * Release all locks for a given run ID.
 */
export function releaseLocksForRun(runId: string): number {
  const locks = queryLocks({ runId, status: 'active' });
  for (const l of locks) {
    releaseLock(l.id);
  }
  return locks.length;
}

/**
 * List locks matching filter.
 */
export function listLocks(filter?: LockFilter): FileLock[] {
  return queryLocks(filter);
}

/**
 * Clean up expired locks.
 */
export function cleanupExpiredLocks(): number {
  const now = Date.now();
  const expired = getActiveLocks().filter(l => new Date(l.expiresAt).getTime() <= now);
  for (const l of expired) {
    updateLockStatus(l.id, 'expired', new Date().toISOString());
    writeLockAudit('lock.expired', {
      sessionId: l.sessionId, runId: l.runId, path: l.path,
      lockId: l.id, mode: l.mode,
    });
  }
  return expired.length;
}
