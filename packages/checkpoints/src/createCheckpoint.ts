import { takeWorkspaceSnapshot } from './fileSnapshot';
import { takeSessionSnapshot } from './sessionSnapshot';
import { CheckpointStore } from './checkpointStore';
import { logCheckpointAudit } from './checkpointAudit';
import type { Checkpoint, SessionSnapshot } from './types';
import { runHooks } from '@ara/hooks';

export interface CreateCheckpointOptions {
  createdBy: 'agent' | 'user' | 'hook' | 'system';
  beforeToolName?: string;
  beforeToolInput?: string;
  specificFiles?: string[];
  customDb?: any;
  metadata?: Record<string, any>;
}

// Helper to get Git head commit hash
async function getGitHead(cwd: string): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(['git', 'rev-parse', 'HEAD'], { cwd, stdout: 'pipe', stderr: 'pipe' });
    const stdout = await new Response(proc.stdout).text();
    const hash = stdout.trim();
    if (hash && /^[0-9a-f]{40}$/.test(hash)) {
      return hash;
    }
  } catch (e) {
    // Git not available or not a repository
  }
  return undefined;
}

export async function createCheckpoint(
  sessionId: string,
  cwd: string,
  reason: string,
  options: CreateCheckpointOptions
): Promise<Checkpoint> {
  const store = new CheckpointStore(cwd);
  const checkpointId = 'chk_' + Math.random().toString(36).substring(2, 10);

  // 1. Take session snapshot
  const sessionSnapshot = await takeSessionSnapshot(sessionId, cwd, options.customDb);

  // 2. Take file snapshots
  const fileSnapshots = await takeWorkspaceSnapshot(cwd, options.specificFiles);

  // 3. Get Git HEAD if any
  const gitHead = await getGitHead(cwd);

  const checkpoint: Checkpoint = {
    id: checkpointId,
    sessionId,
    cwd,
    reason,
    createdAt: new Date().toISOString(),
    createdBy: options.createdBy,
    beforeToolName: options.beforeToolName,
    beforeToolInput: options.beforeToolInput,
    transcriptSeq: sessionSnapshot.transcriptSeq,
    messageCount: sessionSnapshot.messageCount,
    gitHead,
    files: fileSnapshots,
    sessionSnapshot,
    metadata: options.metadata
  };

  // 4. Save checkpoint contents to disk & index
  await store.saveCheckpoint(checkpoint);

  // 5. Append checkpoint creation audit log
  const filesCount = fileSnapshots.filter(f => !f.skipped).length;
  await logCheckpointAudit(
    cwd,
    sessionId,
    'checkpoint.created',
    {
      checkpointId,
      reason,
      createdBy: options.createdBy,
      beforeToolName: options.beforeToolName,
      filesCount,
      messagesCount: sessionSnapshot.messageCount
    },
    `Created checkpoint ${checkpointId} (${reason}) with ${filesCount} snapshotted files.`,
    'success',
    options.customDb
  );

  // 6. Trigger lifecycle hook if runHooks orchestrator is available
  try {
    await runHooks('CheckpointCreated', {
      checkpointId,
      sessionId,
      reason,
      createdBy: options.createdBy
    });
  } catch (err) {
    // Ignore hook run failures so they don't break main checkpoint flow
  }

  return checkpoint;
}

export function shouldCreateCheckpointBeforeTool(toolName: string, input: any): boolean {
  if (toolName === 'write_file' || toolName === 'edit_file') {
    return true;
  }
  
  if (toolName === 'run_shell') {
    const cmd = (input.command || '').toLowerCase();
    const mutatingPatterns = [
      'bun install', 'npm install', 'pnpm install', 'yarn install',
      'git checkout', 'git reset', 'git clean', 'git apply',
      'mv ', 'cp ', 'rm ', 'sed -i',
      'python ', 'node ', 'bun '
    ];
    return mutatingPatterns.some(pat => cmd.includes(pat));
  }
  
  return false;
}
