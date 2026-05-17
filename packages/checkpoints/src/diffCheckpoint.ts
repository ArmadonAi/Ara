import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getCheckpoint } from './getCheckpoint';
import { takeSessionSnapshot } from './sessionSnapshot';
import { discoverWorkspaceFiles, isSecretFile } from './fileSnapshot';
import type { CheckpointDiffResult } from './types';

export async function diffCheckpoint(
  id: string,
  cwd: string,
  customDb?: any
): Promise<CheckpointDiffResult> {
  const checkpoint = await getCheckpoint(id, cwd);
  if (!checkpoint) {
    throw new Error(`Checkpoint "${id}" not found.`);
  }

  const filesChangedSince: string[] = [];
  const filesCreatedSince: string[] = [];
  const filesDeletedSince: string[] = [];
  const filesSkipped: string[] = [];
  const warnings: string[] = [];

  // 1. Fetch current workspace files list
  const currentFiles = await discoverWorkspaceFiles(cwd);
  const currentFilesSet = new Set(currentFiles);

  // Map checkpoint files for quick lookup
  const checkpointFilesMap = new Map(checkpoint.files.map(f => [f.path, f]));

  // 2. Identify deleted files and changed files
  for (const snap of checkpoint.files) {
    if (snap.skipped) {
      filesSkipped.push(snap.path);
      continue;
    }

    if (snap.isLarge || snap.isBinary) {
      warnings.push(`File "${snap.path}" is binary or large (${snap.sizeBytes} bytes). Content was not stored.`);
    }

    const relPath = snap.path;
    const absPath = path.resolve(cwd, relPath);

    if (!currentFilesSet.has(relPath)) {
      // Existed in checkpoint, but not in current workspace -> deleted since
      if (snap.existsBefore) {
        filesDeletedSince.push(relPath);
      }
    } else {
      // Exists in both checkpoint and current workspace -> check for changes
      try {
        const stat = await fs.stat(absPath);
        if (stat.size !== snap.sizeBytes) {
          filesChangedSince.push(relPath);
        } else if (snap.contentHashBefore && !snap.isBinary && !snap.isLarge) {
          // Compare content hash
          const fileBuf = await fs.readFile(absPath);
          const crypto = await import('node:crypto');
          const currentHash = crypto.createHash('sha256').update(fileBuf).digest('hex');
          
          if (currentHash !== snap.contentHashBefore) {
            filesChangedSince.push(relPath);
          }
        }
      } catch (e) {
        // Safe check skip on read errors
      }
    }
  }

  // 3. Identify newly created files since checkpoint
  for (const relPath of currentFiles) {
    if (!checkpointFilesMap.has(relPath)) {
      // Not in checkpoint -> created since
      filesCreatedSince.push(relPath);
    }
  }

  // 4. Determine session changes (message count and transcript sequence diffs)
  let currentMsgCount = checkpoint.messageCount;
  let currentTranscriptSeq = checkpoint.transcriptSeq;

  try {
    const currentSession = await takeSessionSnapshot(checkpoint.sessionId, cwd, customDb);
    currentMsgCount = currentSession.messageCount;
    currentTranscriptSeq = currentSession.transcriptSeq;
  } catch (err) {
    // Session might be deleted or tests running without DB
  }

  const messageCountDiff = currentMsgCount - checkpoint.messageCount;
  const transcriptSeqDiff = currentTranscriptSeq - checkpoint.transcriptSeq;

  return {
    checkpointId: id,
    filesChangedSince,
    filesCreatedSince,
    filesDeletedSince,
    filesSkipped,
    warnings,
    messageCountDiff,
    transcriptSeqDiff
  };
}
