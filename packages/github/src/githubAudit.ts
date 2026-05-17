import type { GitHubAuditRecord } from './types';
import { redactGitHubSecret } from './githubRedaction';

const MAX_CACHE = 1000;
const cache: GitHubAuditRecord[] = [];
let auditPath: string | null = null;

export function initGitHubAudit(filePath?: string | null): void {
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

export function writeGitHubAudit(record: GitHubAuditRecord): void {
  // Write to persistent JSONL
  if (auditPath) {
    try {
      const fs = require('node:fs');
      fs.appendFileSync(auditPath, JSON.stringify(record) + '\n', 'utf8');
    } catch {}
  }
  // In-memory cache
  cache.push(record);
  if (cache.length > MAX_CACHE) {
    cache.splice(0, cache.length - MAX_CACHE);
  }
}

export function listGitHubAudit(opts?: {
  owner?: string; repo?: string; sessionId?: string; limit?: number;
}): GitHubAuditRecord[] {
  let result = cache;
  if (opts?.owner) result = result.filter(r => r.owner === opts.owner);
  if (opts?.repo) result = result.filter(r => r.repo === opts.repo);
  if (opts?.sessionId) result = result.filter(r => r.sessionId === opts.sessionId);
  const limit = Math.min(opts?.limit ?? 100, MAX_CACHE);
  return result.slice(-limit);
}

export function clearGitHubAudit(): void {
  cache.length = 0;
}

export function buildGitHubAuditRecord(opts: {
  sessionId: string;
  toolName: string;
  owner: string;
  repo: string;
  resourceType: GitHubAuditRecord['resourceType'];
  resourceId?: string | number;
  input?: Record<string, unknown>;
  output?: Record<string, unknown> | string;
  status: 'success' | 'failed';
  dangerLevel: 'safe' | 'write' | 'network' | 'dangerous';
  permissionDecision?: string;
  approvalId?: string;
  startedAt: string;
  durationMs?: number;
  error?: string;
}): GitHubAuditRecord {
  const inputSummary = opts.input
    ? JSON.stringify(redactGitHubObject(opts.input)).slice(0, 500)
    : undefined;
  const outputSummary = opts.output
    ? (typeof opts.output === 'string' ? opts.output : JSON.stringify(redactGitHubObject(opts.output))).slice(0, 500)
    : undefined;

  return {
    id: `gh-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    sessionId: opts.sessionId,
    toolName: opts.toolName,
    owner: opts.owner,
    repo: opts.repo,
    resourceType: opts.resourceType,
    resourceId: opts.resourceId,
    inputSummary,
    outputSummary,
    status: opts.status,
    dangerLevel: opts.dangerLevel,
    permissionDecision: opts.permissionDecision,
    approvalId: opts.approvalId,
    startedAt: opts.startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: opts.durationMs,
    error: opts.error ? redactGitHubSecret(opts.error) : undefined,
  };
}

function redactGitHubObject(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') result[key] = redactGitHubSecret(value);
    else if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = redactGitHubObject(value as Record<string, unknown>);
    } else result[key] = value;
  }
  return result;
}

export { redactGitHubSecret };
