import { Database } from 'bun:sqlite';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import type { SessionSnapshot } from './types';

// Helper to open the workspace database
function openWorkspaceDb(cwd: string): Database {
  // Check if database exists in CWD or parent dir
  const dbPaths = [
    path.join(cwd, 'ara.sqlite'),
    path.resolve(cwd, '../ara.sqlite'),
    path.resolve(cwd, '../../ara.sqlite'),
    'ara.sqlite'
  ];
  
  for (const dbPath of dbPaths) {
    if (existsSync(dbPath)) {
      return new Database(dbPath);
    }
  }
  return new Database('ara.sqlite');
}

export async function takeSessionSnapshot(
  sessionId: string,
  cwd: string,
  customDb?: Database
): Promise<SessionSnapshot> {
  const db = customDb || openWorkspaceDb(cwd);
  
  try {
    // 1. Get session details
    const sessionRow = db.query('SELECT * FROM sessions WHERE id = ?').get(sessionId) as any;
    if (!sessionRow) {
      throw new Error(`Session "${sessionId}" not found in database.`);
    }

    // 2. Get messages list
    const messagesRows = db.query('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC').all(sessionId) as any[];
    const messageIds = messagesRows.map(m => m.id);
    const messageCount = messagesRows.length;

    // 3. Get pending approvals list
    const approvalsRows = db.query('SELECT id FROM approvals WHERE session_id = ? AND status = ?').all(sessionId, 'pending') as any[];
    const pendingApprovalIds = approvalsRows.map(a => a.id);

    // 4. Compact digest / active model / permission mode
    // We can query the Hono API config state or permission active state if saved in DB, otherwise use default settings.
    // In our SQLite, config is mostly activeModel and defaultPermissionMode. We can look them up, or use sessionRow.model.
    const activeModel = sessionRow.model || 'Gemini';
    
    // Check permission mode
    let permissionMode = 'default';
    try {
      const modeRow = db.query('SELECT value FROM config WHERE key = ?').get('permissionMode') as any;
      if (modeRow) {
        permissionMode = modeRow.value;
      }
    } catch (e) {
      // Config table might not exist or be empty
    }

    // Get current transcript seq count by reading the transcript JSONL file if available
    let transcriptSeq = 0;
    try {
      const fs = await import('node:fs/promises');
      const transcriptPath = path.join(cwd, '.ara', 'sessions', `${sessionId}.jsonl`);
      if (existsSync(transcriptPath)) {
        const lines = (await fs.readFile(transcriptPath, 'utf8')).trim().split('\n');
        transcriptSeq = lines.length;
      }
    } catch (e) {
      // Transcript file doesn't exist
    }

    return {
      sessionId,
      messageIds,
      messageCount,
      activeModel,
      permissionMode,
      transcriptSeq,
      pendingApprovalIds,
      createdAt: new Date().toISOString()
    };
  } finally {
    if (!customDb) {
      db.close();
    }
  }
}

export async function restoreSessionSnapshot(
  snapshot: SessionSnapshot,
  cwd: string,
  customDb?: Database
): Promise<void> {
  const db = customDb || openWorkspaceDb(cwd);
  
  try {
    // 1. Verify session exists
    const sessionRow = db.query('SELECT * FROM sessions WHERE id = ?').get(snapshot.sessionId) as any;
    if (!sessionRow) {
      db.run(
        'INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        [snapshot.sessionId, `Restored Session ${snapshot.sessionId}`, snapshot.activeModel, snapshot.createdAt, new Date().toISOString()]
      );
    } else {
      db.run(
        'UPDATE sessions SET model = ?, updated_at = ? WHERE id = ?',
        [snapshot.activeModel, new Date().toISOString(), snapshot.sessionId]
      );
    }

    // 2. Keep messages that belong to the snapshot by pruning any newer messages
    // To do this safely and auditably, we keep only message IDs present in the snapshot
    const messageIdPlaceholders = snapshot.messageIds.map(() => '?').join(',');
    if (snapshot.messageIds.length > 0) {
      db.run(
        `DELETE FROM messages WHERE session_id = ? AND id NOT IN (${messageIdPlaceholders})`,
        [snapshot.sessionId, ...snapshot.messageIds]
      );
    } else {
      db.run('DELETE FROM messages WHERE session_id = ?', [snapshot.sessionId]);
    }

    // 3. Mark approvals that were pending at checkpoint back to pending, and delete approvals that didn't exist
    if (snapshot.pendingApprovalIds.length > 0) {
      const approvalPlaceholders = snapshot.pendingApprovalIds.map(() => '?').join(',');
      db.run(
        `UPDATE approvals SET status = 'pending' WHERE session_id = ? AND id IN (${approvalPlaceholders})`,
        [snapshot.sessionId, ...snapshot.pendingApprovalIds]
      );
      db.run(
        `DELETE FROM approvals WHERE session_id = ? AND id NOT IN (${approvalPlaceholders})`,
        [snapshot.sessionId, ...snapshot.pendingApprovalIds]
      );
    } else {
      db.run("DELETE FROM approvals WHERE session_id = ? AND status = 'pending'", [snapshot.sessionId]);
    }
  } finally {
    if (!customDb) {
      db.close();
    }
  }
}
