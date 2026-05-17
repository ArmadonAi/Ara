import type { SkillUsageStats } from './types';
import { writeSkillLearningAudit } from './skillLearningAudit';
import * as fs from 'node:fs';
import * as path from 'node:path';

const stats = new Map<string, SkillUsageStats>();
let persistencePath: string | null = null;

/** Initialize stats persistence. */
export function initStatsStore(filePath?: string | null): void {
  if (filePath) {
    persistencePath = filePath;
    const dir = path.dirname(filePath);
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    reloadStats();
  } else {
    persistencePath = null;
  }
}

/** Reload stats from disk. */
export function reloadStats(): number {
  if (!persistencePath) return 0;
  try {
    if (!fs.existsSync(persistencePath)) return 0;
    const raw = fs.readFileSync(persistencePath, 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);
    let loaded = 0;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as { key: string; stat: SkillUsageStats };
        if (entry.key && entry.stat) {
          stats.set(entry.key, entry.stat);
          loaded++;
        }
      } catch {}
    }
    return loaded;
  } catch {
    return 0;
  }
}

function persistStat(key: string, stat: SkillUsageStats): void {
  if (!persistencePath) return;
  try {
    fs.appendFileSync(persistencePath, JSON.stringify({ key, stat }) + '\n', 'utf8');
  } catch {}
}

/**
 * Record usage of a skill.
 */
export function recordSkillUsage(
  skillName: string,
  version: number,
  outcome: 'success' | 'failed',
  durationMs?: number,
  feedbackScore?: number,
): SkillUsageStats {
  const key = `${skillName}:${version}`;
  const existing = stats.get(key);
  const now = new Date().toISOString();

  if (existing) {
    existing.useCount += 1;
    if (outcome === 'success') existing.successCount += 1;
    else existing.failureCount += 1;
    existing.lastUsedAt = now;
    if (durationMs !== undefined) {
      existing.avgDurationMs = Math.round(
        (existing.avgDurationMs * (existing.useCount - 1) + durationMs) / existing.useCount
      );
    }
    if (feedbackScore !== undefined) existing.feedbackScore = feedbackScore;
    persistStat(key, existing);
    writeSkillLearningAudit('skill_learning.usage_recorded', {
      skillName, details: `version=${version} outcome=${outcome}`,
    });
    return existing;
  }

  const newStats: SkillUsageStats = {
    skillName,
    version,
    useCount: 1,
    successCount: outcome === 'success' ? 1 : 0,
    failureCount: outcome === 'failed' ? 1 : 0,
    lastUsedAt: now,
    avgDurationMs: durationMs || 0,
    feedbackScore,
  };

  stats.set(key, newStats);
  persistStat(key, newStats);
  writeSkillLearningAudit('skill_learning.usage_recorded', {
    skillName, details: `version=${version} first_use`,
  });
  return newStats;
}

/**
 * Get stats for a specific skill.
 */
export function getSkillStats(skillName: string, version?: number): SkillUsageStats | null {
  if (version) return stats.get(`${skillName}:${version}`) || null;
  const all = Array.from(stats.entries())
    .filter(([k]) => k.startsWith(skillName + ':'))
    .map(([, v]) => v);
  if (all.length === 0) return null;
  return all.reduce((combined, current) => ({
    skillName,
    version: current.version,
    useCount: combined.useCount + current.useCount,
    successCount: combined.successCount + current.successCount,
    failureCount: combined.failureCount + current.failureCount,
    lastUsedAt: combined.lastUsedAt > current.lastUsedAt ? combined.lastUsedAt : current.lastUsedAt,
    avgDurationMs: Math.round((combined.avgDurationMs + current.avgDurationMs) / 2),
  }));
}

/**
 * List all skill stats.
 */
export function listSkillStats(): SkillUsageStats[] {
  const unique = new Map<string, SkillUsageStats>();
  for (const [, s] of stats) {
    const existing = unique.get(s.skillName);
    if (!existing || s.version > existing.version) {
      unique.set(s.skillName, s);
    }
  }
  return Array.from(unique.values()).sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
}

/**
 * Clear all stats (for testing).
 */
export function clearStats(): void {
  stats.clear();
}
