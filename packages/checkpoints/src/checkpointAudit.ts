import { Database } from 'bun:sqlite';
import * as path from 'node:path';
import { existsSync } from 'node:fs';

function openWorkspaceDb(cwd: string): Database {
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

export async function logCheckpointAudit(
  cwd: string,
  sessionId: string,
  eventType: string,
  input: Record<string, any>,
  output: string,
  status: 'success' | 'failed' | 'blocked',
  customDb?: Database
): Promise<void> {
  const db = customDb || openWorkspaceDb(cwd);
  
  try {
    const id = 'aud_' + Math.random().toString(36).substring(2, 10);
    db.run(
      'INSERT INTO audit_logs (id, session_id, tool_name, input, output, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        id,
        sessionId,
        eventType,
        JSON.stringify(input),
        output,
        status === 'blocked' ? 'failed' : status,
        new Date().toISOString()
      ]
    );
  } catch (err) {
    // Fail silently in case db schema does not exist yet (e.g. initial boot tests)
  } finally {
    if (!customDb) {
      db.close();
    }
  }
}
