const MAX_RECORDS = 1000;
const records: LockAuditRecord[] = [];
let auditPath: string | null = null;

export interface LockAuditRecord {
  id: string;
  event: string;
  sessionId: string;
  runId?: string;
  path?: string;
  lockId?: string;
  mode?: string;
  reason?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export function initLockAudit(filePath?: string | null): void {
  if (filePath) {
    auditPath = filePath;
    try {
      const fs = require('node:fs');
      const dir = filePath.substring(0, filePath.lastIndexOf('/'));
      if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch {}
  } else {
    auditPath = null;
  }
}

export function writeLockAudit(event: string, data: {
  sessionId: string;
  runId?: string;
  path?: string;
  lockId?: string;
  mode?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}): void {
  const record: LockAuditRecord = {
    id: `lock-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    event,
    sessionId: data.sessionId,
    runId: data.runId,
    path: data.path,
    lockId: data.lockId,
    mode: data.mode,
    reason: data.reason,
    timestamp: new Date().toISOString(),
    metadata: data.metadata,
  };

  // Write to persistent JSONL
  if (auditPath) {
    try {
      const fs = require('node:fs');
      fs.appendFileSync(auditPath, JSON.stringify(record) + '\n', 'utf8');
    } catch {}
  }

  // In-memory cache
  records.push(record);
  if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
}

export function listLockAudit(limit: number = 100): LockAuditRecord[] {
  return records.slice(-limit);
}

export function clearLockAudit(): void {
  records.length = 0;
}
