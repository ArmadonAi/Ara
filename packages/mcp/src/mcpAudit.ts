import type { MCPAuditRecord } from './types';

/**
 * MCP audit store with persistent local-first storage.
 *
 * Primary: append-only `.ara/audit/mcp.jsonl` file.
 * Cache: ring buffer for fast queries (last 1000 records).
 *
 * Never logs secrets. Always redacts sk-*, sk-ant-*, AIza*, ghp_*, glpat-*.
 */
const MAX_CACHE = 1000;
let cache: MCPAuditRecord[] = [];
let auditDbPath: string | null = null;
let auditEnabled = true;

// ── Initialization ─────────────────────────────────────────────────

/**
 * Initialize the audit store with a persistent path.
 * If path is null/empty, operates in memory-only mode (default for tests).
 */
export function initAuditStore(dbPath?: string | null): void {
  if (dbPath) {
    auditDbPath = dbPath;
    // Ensure directory exists
    const dir = dbPath.substring(0, dbPath.lastIndexOf('/'));
    if (dir) {
      try {
        const fs = require('node:fs');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      } catch {
        // directory may already exist
      }
    }
    // Preload last N cache entries from existing file
    _preloadCache();
  } else {
    auditDbPath = null;
  }
  auditEnabled = true;
}

export function setAuditEnabled(enabled: boolean): void {
  auditEnabled = enabled;
}

export function getAuditPath(): string | null {
  return auditDbPath;
}

// ── Write ──────────────────────────────────────────────────────────

export function writeMCPAudit(record: MCPAuditRecord): void {
  if (!auditEnabled) return;

  // 1. Write to persistent storage (append-only JSONL)
  if (auditDbPath) {
    try {
      const fs = require('node:fs');
      fs.appendFileSync(auditDbPath, JSON.stringify(record) + '\n', 'utf8');
    } catch {
      // If file write fails, still keep in cache
    }
  }

  // 2. Update ring buffer cache
  cache.push(record);
  if (cache.length > MAX_CACHE) {
    cache.splice(0, cache.length - MAX_CACHE);
  }
}

export function writeMCPAuditBatch(records: MCPAuditRecord[]): void {
  for (const r of records) writeMCPAudit(r);
}

// ── Read ───────────────────────────────────────────────────────────

export function listMCPAudit(
  opts?: { serverId?: string; sessionId?: string; limit?: number }
): MCPAuditRecord[] {
  let result = cache;
  if (opts?.serverId) {
    result = result.filter(r => r.serverId === opts.serverId);
  }
  if (opts?.sessionId) {
    result = result.filter(r => r.sessionId === opts.sessionId);
  }
  const limit = Math.min(opts?.limit ?? 100, MAX_CACHE);
  return result.slice(-limit);
}

/**
 * Re-read audit file and rebuild cache from persistent storage.
 * Useful after server restart to load historical records.
 */
export function reloadAuditFromDisk(): number {
  if (!auditDbPath) return 0;
  try {
    const fs = require('node:fs');
    if (!fs.existsSync(auditDbPath)) return 0;

    const content = fs.readFileSync(auditDbPath, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    const records: MCPAuditRecord[] = [];

    for (const line of lines) {
      try {
        records.push(JSON.parse(line));
      } catch {
        // skip malformed lines
      }
    }

    // Keep only last MAX_CACHE
    const loaded = records.slice(-MAX_CACHE);
    cache = loaded;
    return loaded.length;
  } catch {
    return 0;
  }
}

export function clearMCPAudit(): void {
  cache = [];
  // Note: does NOT clear the persistent file — only in-memory cache.
  // Use clearAuditFile() to reset the file for testing.
}

/** Clear the persistent audit file (test utility). */
export function clearAuditFile(): void {
  cache = [];
  if (auditDbPath) {
    try {
      const fs = require('node:fs');
      fs.writeFileSync(auditDbPath, '', 'utf8');
    } catch {
      // ignore
    }
  }
}

export function getAuditCount(): number {
  return cache.length;
}

// ── Build sanitized record ─────────────────────────────────────────

/**
 * Build a sanitized audit record from an MCP call.
 * Strips raw API keys from inputs and any error messages.
 */
export function buildMCPAuditRecord(opts: {
  eventType: MCPAuditRecord['eventType'];
  serverId: string;
  serverName: string;
  sessionId: string;
  toolName?: string;
  fullToolName?: string;
  input?: Record<string, unknown>;
  result?: { ok: boolean; outputSummary?: string; content?: string; error?: string };
  permissionDecision?: string;
  approvalId?: string;
  startedAt: string;
  durationMs?: number;
  dangerLevel?: string;
}): MCPAuditRecord {
  const inputSummary = opts.input ? summarizeInput(opts.input) : undefined;
  const resultSummary = opts.result
    ? opts.result.ok
      ? opts.result.outputSummary || (opts.result.content || '').slice(0, 500)
      : `[ERROR] ${opts.result.error}`
    : undefined;

  const record: MCPAuditRecord = {
    id: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    eventType: opts.eventType,
    serverId: opts.serverId,
    serverName: opts.serverName,
    sessionId: opts.sessionId,
    toolName: opts.toolName,
    fullToolName: opts.fullToolName,
    inputSummary,
    outputSummary: resultSummary,
    status: opts.result?.ok ? 'success' : 'failed',
    dangerLevel: opts.dangerLevel,
    permissionDecision: opts.permissionDecision,
    approvalId: opts.approvalId,
    startedAt: opts.startedAt,
    finishedAt: opts.result ? new Date().toISOString() : undefined,
    durationMs: opts.durationMs,
  };

  if (opts.result?.error) {
    record.error = redactSecret(opts.result.error);
  }
  return record;
}

// ── Helpers ────────────────────────────────────────────────────────

function summarizeInput(input: Record<string, unknown>): string {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string') {
      safe[k] = redactSecret(v);
    } else {
      safe[k] = v;
    }
  }
  try {
    return JSON.stringify(safe).slice(0, 500);
  } catch {
    return '[serialization error]';
  }
}

export function redactSecret(str: string): string {
  return str
    .replace(/sk-[a-zA-Z0-9]{32,}/g, '[REDACTED]')
    .replace(/sk-ant-[a-zA-Z0-9_-]{20,}/g, '[REDACTED]')
    .replace(/AIza[0-9A-Za-z-_]{35}/g, '[REDACTED]')
    .replace(/ghp_[a-zA-Z0-9]{36,}/g, '[REDACTED]')
    .replace(/glpat-[a-zA-Z0-9\-_]{20,}/g, '[REDACTED]');
}

// ── Internal ────────────────────────────────────────────────────────

function _preloadCache(): void {
  reloadAuditFromDisk();
}
