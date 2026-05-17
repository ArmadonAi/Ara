import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { getCheckpoint } from './getCheckpoint';
import { restoreSessionSnapshot } from './sessionSnapshot';
import { CheckpointStore } from './checkpointStore';
import { logCheckpointAudit } from './checkpointAudit';
import { resolvePathSafety, evaluatePermission } from '@ara/permissions';
import { runHooks } from '@ara/hooks';
import type { CheckpointRestoreMode, CheckpointRestoreResult } from './types';

export async function restoreCheckpoint(
  id: string,
  cwd: string,
  mode: CheckpointRestoreMode,
  customDb?: any
): Promise<CheckpointRestoreResult> {
  const store = new CheckpointStore(cwd);
  const checkpoint = await getCheckpoint(id, cwd);

  if (!checkpoint) {
    throw new Error(`Checkpoint "${id}" not found.`);
  }

  const restoredAt = new Date().toISOString();
  const filesRestored: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  let messagesRestored = 0;
  let transcriptSeqRestored = checkpoint.transcriptSeq;

  // 1. Audit request
  await logCheckpointAudit(
    cwd,
    checkpoint.sessionId,
    'checkpoint.restore_requested',
    { checkpointId: id, mode },
    `Requested restore of checkpoint ${id} with mode "${mode}".`,
    'success',
    customDb
  );

  // 2. Trigger lifecycle hook
  try {
    await runHooks('CheckpointRestoreRequested', {
      checkpointId: id,
      sessionId: checkpoint.sessionId,
      mode
    });
  } catch (err: any) {
    await logCheckpointAudit(
      cwd,
      checkpoint.sessionId,
      'checkpoint.restore_blocked',
      { checkpointId: id, mode, error: err.message },
      `Restore blocked by hook constraint: ${err.message}`,
      'blocked',
      customDb
    );
    throw new Error(`Restore blocked by hook constraint: ${err.message}`);
  }

  // 3. Restore files (code_only or both)
  if (mode === 'code_only' || mode === 'both') {
    for (const snap of checkpoint.files) {
      const relPath = snap.path;
      const absPath = snap.absolutePath;

      // Evaluate path safety before writing/restoring
      const safety = resolvePathSafety(relPath, cwd);
      if (!safety.safe) {
        errors.push(`Access to file "${relPath}" denied: ${safety.reason}`);
        continue;
      }

      if (snap.skipped) {
        warnings.push(`File "${relPath}" was skipped in checkpoint. Restoring skipped.`);
        continue;
      }

      try {
        if (!snap.existsBefore) {
          // File did not exist in checkpoint -> delete if exists now
          if (existsSync(absPath)) {
            await fs.unlink(absPath);
            filesRestored.push(relPath);
          }
        } else {
          // File did exist in checkpoint -> restore content
          const content = await store.getSnapshotFileContent(id, relPath);
          if (content !== null) {
            // Ensure parent directories exist
            await fs.mkdir(path.dirname(absPath), { recursive: true });
            await fs.writeFile(absPath, content, 'utf8');
            filesRestored.push(relPath);
          } else {
            warnings.push(`Snapshot content for "${relPath}" not found in storage.`);
          }
        }
      } catch (err: any) {
        errors.push(`Failed to restore file "${relPath}": ${err.message}`);
      }
    }
  }

  // 4. Restore conversation state (conversation_only or both)
  if (mode === 'conversation_only' || mode === 'both') {
    try {
      await restoreSessionSnapshot(checkpoint.sessionSnapshot, cwd, customDb);
      messagesRestored = checkpoint.sessionSnapshot.messageCount;

      // Add a session.restored event to JSONL transcript
      try {
        const transcriptPath = path.join(cwd, '.ara', 'sessions', `${checkpoint.sessionId}.jsonl`);
        if (existsSync(transcriptPath)) {
          const eventLine = JSON.stringify({
            seq: checkpoint.sessionSnapshot.transcriptSeq + 1,
            sessionId: checkpoint.sessionId,
            eventType: 'session.restored',
            payload: {
              checkpointId: id,
              mode,
              restoredAt
            },
            createdAt: restoredAt
          });
          await fs.appendFile(transcriptPath, eventLine + '\n', 'utf8');
          transcriptSeqRestored = checkpoint.sessionSnapshot.transcriptSeq + 1;
        }
      } catch (e) {
        // Transcript write error ignored
      }
    } catch (err: any) {
      errors.push(`Failed to restore conversation state: ${err.message}`);
    }
  }

  const successStatus = errors.length === 0 ? 'success' : 'failed';

  // 5. Post restore audit
  await logCheckpointAudit(
    cwd,
    checkpoint.sessionId,
    successStatus === 'success' ? 'checkpoint.restored' : 'checkpoint.restore_failed',
    {
      checkpointId: id,
      mode,
      filesRestoredCount: filesRestored.length,
      errorsCount: errors.length
    },
    successStatus === 'success'
      ? `Successfully restored checkpoint ${id} in "${mode}" mode.`
      : `Failed to restore checkpoint ${id}: ${errors.join(', ')}`,
    successStatus,
    customDb
  );

  // 6. Trigger post hook
  try {
    if (successStatus === 'success') {
      await runHooks('CheckpointRestored', {
        checkpointId: id,
        sessionId: checkpoint.sessionId,
        mode
      });
    } else {
      await runHooks('CheckpointRestoreFailed', {
        checkpointId: id,
        sessionId: checkpoint.sessionId,
        mode,
        errors
      });
    }
  } catch (err) {
    // Ignore hook exceptions
  }

  return {
    checkpointId: id,
    mode,
    filesRestored,
    messagesRestored,
    transcriptSeqRestored,
    warnings,
    errors,
    restoredAt
  };
}
