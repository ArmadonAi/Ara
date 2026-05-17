import type { ParallelSubagentRun, SubagentProfile, SubagentRunResult } from './types';
import { SubagentResultSchema } from './schema';
import type { SubagentRuntimeContext } from './runSubagent';
import { runSubagent } from './runSubagent';
import { createSubagentRun } from './createSubagentRun';
import { selectSubagent } from './selectSubagent';
import { loadAgentProfiles } from './loadAgentProfiles';

// In-memory store for parallel runs
const runs = new Map<string, ParallelSubagentRun>();
const abortControllers = new Map<string, AbortController>();

let runCounter = 0;
function generateId(): string {
  runCounter++;
  return `para-${Date.now()}-${runCounter}`;
}

/**
 * Run multiple subagents in parallel with controlled concurrency.
 */
export async function startParallelRun(
  profiles: { name: string; task: string }[],
  parentSessionId: string,
  agentsDir: string,
  runtimeCtx: SubagentRuntimeContext,
  maxConcurrency: number = 3,
): Promise<ParallelSubagentRun> {
  // Use the first profile's task as the parent task, or a default
  const parentTask = profiles[0]?.task || 'Parallel subagent run';
  const run: ParallelSubagentRun = {
    id: generateId(),
    parentSessionId,
    parentTask,
    profiles,
    status: 'running',
    results: [],
    maxConcurrency: Math.max(1, maxConcurrency),
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
  };

  runs.set(run.id, run);
  const abort = new AbortController();
  abortControllers.set(run.id, abort);

  // Run asynchronously (don't await — caller gets status via API)
  executeParallelRun(run, agentsDir, runtimeCtx, abort.signal).catch(() => {});

  return run;
}

async function executeParallelRun(
  run: ParallelSubagentRun,
  agentsDir: string,
  runtimeCtx: SubagentRuntimeContext,
  abortSignal: AbortSignal,
): Promise<void> {
  const allProfiles = await loadAgentProfiles(agentsDir);
  const results: SubagentRunResult[] = [];
  const queue = [...run.profiles];

  // Process queue with concurrency limit
  const workers: Promise<void>[] = [];
  for (let i = 0; i < run.maxConcurrency; i++) {
    workers.push(processQueue(run, queue, allProfiles, agentsDir, results, runtimeCtx, abortSignal));
  }

  await Promise.all(workers);

  if (abortSignal.aborted) {
    run.status = 'cancelled';
  } else {
    run.status = 'completed';
  }
  run.finishedAt = new Date().toISOString();
  run.results = results;
}

async function processQueue(
  run: ParallelSubagentRun,
  queue: { name: string; task: string }[],
  allProfiles: SubagentProfile[],
  agentsDir: string,
  results: SubagentRunResult[],
  runtimeCtx: SubagentRuntimeContext,
  abortSignal: AbortSignal,
): Promise<void> {
  while (queue.length > 0 && !abortSignal.aborted) {
    const job = queue.shift()!;
    try {
      const profile = selectSubagent(allProfiles, job.name);
      if (!profile) {
        results.push({ runId: 'error', profileName: job.name, status: 'failed', error: `Profile "${job.name}" not found` });
        continue;
      }

      const subRun = createSubagentRun(run.parentSessionId, profile, job.task, '', {
        maxTurns: profile.maxTurns,
      });

      const result = await runSubagent(subRun, profile, runtimeCtx);

      results.push({
        runId: subRun.id,
        profileName: job.name,
        status: 'completed',
        summary: formatResultSummary(result),
      });
    } catch (e: any) {
      results.push({ runId: 'error', profileName: job.name, status: 'failed', error: e.message });
    }
  }
}

function formatResultSummary(result: any): string {
  if (typeof result === 'string') return result.slice(0, 500);
  if (result.summary) return result.summary.slice(0, 500);
  if (result.findings) return (Array.isArray(result.findings) ? result.findings.join('; ') : String(result.findings)).slice(0, 500);
  return JSON.stringify(result).slice(0, 500);
}

// ── Management ─────────────────────────────────────────────────────

export function cancelParallelRun(runId: string): boolean {
  const run = runs.get(runId);
  if (!run) return false;
  if (run.status !== 'running' && run.status !== 'pending') return false;

  run.status = 'cancelled';
  run.finishedAt = new Date().toISOString();
  const abort = abortControllers.get(runId);
  if (abort) abort.abort();
  return true;
}

export function getParallelRun(runId: string): ParallelSubagentRun | undefined {
  return runs.get(runId);
}

export function listParallelRuns(): ParallelSubagentRun[] {
  return Array.from(runs.values())
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export function clearParallelRuns(): void {
  runs.clear();
  abortControllers.clear();
}
