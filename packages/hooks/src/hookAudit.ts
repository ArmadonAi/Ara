import { Database } from 'bun:sqlite';
import type { HookAuditRecord, HookEventName, HookType, HookDecision } from './types';

let dbInstance: Database | null = null;

export function getAuditDb(dbPath: string = 'ara.sqlite'): Database {
  if (!dbInstance) {
    dbInstance = new Database(dbPath);
    dbInstance.run(`
      CREATE TABLE IF NOT EXISTS hook_audit_logs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        event TEXT NOT NULL,
        hook_name TEXT NOT NULL,
        hook_type TEXT NOT NULL,
        matcher TEXT,
        command_or_url TEXT NOT NULL,
        status TEXT NOT NULL,
        decision TEXT NOT NULL,
        reason TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        duration_ms INTEGER NOT NULL,
        output_summary TEXT,
        error TEXT
      )
    `);
  }
  return dbInstance;
}

export function resetAuditDbInstance() {
  dbInstance = null;
}

export function writeHookAuditLog(record: HookAuditRecord, dbPath?: string) {
  try {
    const db = getAuditDb(dbPath);
    const stmt = db.prepare(`
      INSERT INTO hook_audit_logs (
        id, session_id, event, hook_name, hook_type, matcher,
        command_or_url, status, decision, reason, started_at,
        finished_at, duration_ms, output_summary, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      record.id,
      record.sessionId,
      record.event,
      record.hookName,
      record.hookType,
      record.matcher || null,
      record.commandOrUrl,
      record.status,
      record.decision,
      record.reason || null,
      record.startedAt,
      record.finishedAt || null,
      record.durationMs,
      record.outputSummary || null,
      record.error || null
    );
  } catch (e) {
    // Fail silently to avoid breaking Ara core execution if DB write fails
    console.error('Failed to write hook audit log:', e);
  }
}

export function listHookAuditLogs(sessionId?: string, dbPath?: string): HookAuditRecord[] {
  try {
    const db = getAuditDb(dbPath);
    if (sessionId) {
      const stmt = db.prepare('SELECT * FROM hook_audit_logs WHERE session_id = ? ORDER BY started_at DESC');
      const rows = stmt.all(sessionId) as any[];
      return rows.map(mapRowToRecord);
    } else {
      const rows = db.query('SELECT * FROM hook_audit_logs ORDER BY started_at DESC').all() as any[];
      return rows.map(mapRowToRecord);
    }
  } catch (e) {
    return [];
  }
}

function mapRowToRecord(row: any): HookAuditRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    event: row.event as HookEventName,
    hookName: row.hook_name,
    hookType: row.hook_type as HookType,
    matcher: row.matcher || undefined,
    commandOrUrl: row.command_or_url,
    status: row.status as 'success' | 'failed',
    decision: row.decision as HookDecision,
    reason: row.reason || undefined,
    startedAt: row.started_at,
    finishedAt: row.finished_at || undefined,
    durationMs: Number(row.duration_ms),
    outputSummary: row.output_summary || undefined,
    error: row.error || undefined
  };
}
