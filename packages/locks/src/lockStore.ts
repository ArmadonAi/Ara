import type { FileLock, LockFilter, LockStatus } from './types';

const locks: FileLock[] = [];

export function addLock(lock: FileLock): void {
  locks.push(lock);
}

export function updateLockStatus(id: string, status: LockStatus, releasedAt?: string): FileLock | undefined {
  const lock = locks.find(l => l.id === id);
  if (!lock) return undefined;
  lock.status = status;
  if (releasedAt) lock.releasedAt = releasedAt;
  return lock;
}

export function removeLock(id: string): boolean {
  const idx = locks.findIndex(l => l.id === id);
  if (idx === -1) return false;
  locks.splice(idx, 1);
  return true;
}

export function findLock(id: string): FileLock | undefined {
  return locks.find(l => l.id === id);
}

export function queryLocks(filter?: LockFilter): FileLock[] {
  let result = [...locks];
  if (filter?.sessionId) result = result.filter(l => l.sessionId === filter.sessionId);
  if (filter?.runId) result = result.filter(l => l.runId === filter.runId);
  if (filter?.path) result = result.filter(l => l.path === filter.path);
  if (filter?.mode) result = result.filter(l => l.mode === filter.mode);
  if (filter?.status) result = result.filter(l => l.status === filter.status);
  if (filter?.workspaceId) result = result.filter(l => l.workspaceId === filter.workspaceId);
  return result;
}

export function getActiveLocks(): FileLock[] {
  return locks.filter(l => l.status === 'active');
}

export function clearLocks(): void {
  locks.length = 0;
}
