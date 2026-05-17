import type { WorkflowFingerprint } from './types';
import { writeSkillLearningAudit } from './skillLearningAudit';
import * as fs from 'node:fs';
import * as path from 'node:path';

// In-memory store for workflow fingerprints
const fingerprints: Map<string, WorkflowFingerprint> = new Map();
let persistencePath: string | null = null;

let counter = 0;
function genId(): string {
  counter++;
  return `wf-${Date.now()}-${counter}`;
}

/** Initialize persistence to a file path. */
export function initFingerprintStore(filePath?: string | null): void {
  if (filePath) {
    persistencePath = filePath;
    // Ensure directory exists
    const dir = path.dirname(filePath);
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    // Reload existing fingerprints
    reloadFingerprints();
  } else {
    persistencePath = null;
  }
}

/** Reload fingerprints from the JSONL file. */
export function reloadFingerprints(): number {
  if (!persistencePath) return 0;
  try {
    if (!fs.existsSync(persistencePath)) return 0;
    const raw = fs.readFileSync(persistencePath, 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);
    let loaded = 0;
    for (const line of lines) {
      try {
        const fp = JSON.parse(line) as { key: string; fingerprint: WorkflowFingerprint };
        if (fp.key && fp.fingerprint) {
          fingerprints.set(fp.key, fp.fingerprint);
          loaded++;
        }
      } catch {
        // skip malformed lines
      }
    }
    return loaded;
  } catch {
    return 0;
  }
}

/** Append a fingerprint entry to the JSONL file. */
function persistFingerprint(key: string, fp: WorkflowFingerprint): void {
  if (!persistencePath) return;
  try {
    fs.appendFileSync(persistencePath, JSON.stringify({ key, fingerprint: fp }) + '\n', 'utf8');
  } catch {
    // if write fails, still keep in memory
  }
}

/**
 * Normalize a goal string for fingerprinting.
 */
export function normalizeGoal(goal: string): string {
  return goal
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/**
 * Generate a workflow fingerprint key from session data.
 */
export function generateWorkflowFingerprint(data: {
  goal: string;
  toolSequence: string[];
  filesTouched?: string[];
  skillNamesUsed?: string[];
  memoryKeysUsed?: string[];
  outcome?: 'success' | 'partial' | 'failed';
}): string {
  const normalized = normalizeGoal(data.goal);
  const toolSeq = (data.toolSequence || []).join(',');
  const filePatterns = (data.filesTouched || []).map(f => {
    if (f.includes('src/')) return 'src/**';
    if (f.includes('tests/')) return 'tests/**';
    if (f.includes('docs/')) return 'docs/**';
    if (f.endsWith('.test.ts')) return '*.test.ts';
    if (f.endsWith('.ts')) return '*.ts';
    if (f.endsWith('.json')) return '*.json';
    if (f.endsWith('.md')) return '*.md';
    return '*';
  }).sort().join(',');
  return `${normalized}|${toolSeq}|${filePatterns}`;
}

/**
 * Find or create a fingerprint for the given data.
 */
export function updateWorkflowFingerprint(data: {
  goal: string;
  toolSequence: string[];
  filesTouched?: string[];
  skillNamesUsed?: string[];
  memoryKeysUsed?: string[];
  outcome?: 'success' | 'partial' | 'failed';
}): WorkflowFingerprint {
  const fp = generateWorkflowFingerprint(data);
  const existing = fingerprints.get(fp);
  const now = new Date().toISOString();

  if (existing) {
    existing.count += 1;
    existing.lastSeenAt = now;
    existing.outcome = data.outcome || existing.outcome;
    for (const t of data.toolSequence || []) {
      if (!existing.toolSequence.includes(t)) existing.toolSequence.push(t);
    }
    persistFingerprint(fp, existing); // persist update
    return existing;
  }

  const newFp: WorkflowFingerprint = {
    id: genId(),
    normalizedGoal: normalizeGoal(data.goal),
    toolSequence: [...(data.toolSequence || [])],
    filesTouchedPatterns: (data.filesTouched || []).map(f => {
      if (f.includes('src/')) return 'src/**';
      if (f.includes('tests/')) return 'tests/**';
      if (f.endsWith('.ts')) return '*.ts';
      return '*';
    }),
    skillNamesUsed: [...(data.skillNamesUsed || [])],
    memoryKeysUsed: [...(data.memoryKeysUsed || [])],
    outcome: data.outcome || 'success',
    count: 1,
    firstSeenAt: now,
    lastSeenAt: now,
  };

  fingerprints.set(fp, newFp);
  persistFingerprint(fp, newFp);
  writeSkillLearningAudit('skill_learning.workflow_detected', {
    details: `goal=${data.goal.slice(0, 60)} count=1`,
  });

  return newFp;
}

/**
 * Find repeated workflows that meet the threshold.
 */
export function findRepeatedWorkflows(threshold: number = 3): WorkflowFingerprint[] {
  return Array.from(fingerprints.values())
    .filter(fp => fp.count >= threshold)
    .sort((a, b) => b.count - a.count);
}

/**
 * List all workflow fingerprints.
 */
export function listWorkflowFingerprints(): WorkflowFingerprint[] {
  return Array.from(fingerprints.values())
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

/**
 * Clear all fingerprints (for testing).
 */
export function clearFingerprints(): void {
  fingerprints.clear();
}
