// @ara/locks — File locking and parallel subagent coordination

export * from './types';
export * from './schema';
export { acquireLock, acquireMany, releaseLock, releaseLocksForRun, forceReleaseLock, listLocks, cleanupExpiredLocks, detectConflicts } from './lockManager';
export { addLock, updateLockStatus, findLock, queryLocks, getActiveLocks, clearLocks } from './lockStore';
export { normalizePath, resolveRealPath, isPathInWorkspace, pathsConflict } from './pathLocking';
export { writeLockAudit, listLockAudit, clearLockAudit, initLockAudit } from './lockAudit';
export type { LockAuditRecord } from './lockAudit';
