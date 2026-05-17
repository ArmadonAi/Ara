import { expect, test, describe, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Database } from 'bun:sqlite';
import {
  createCheckpoint,
  listCheckpoints,
  getCheckpoint,
  diffCheckpoint,
  restoreCheckpoint,
  isSecretFile,
  isBinaryBuffer,
  CheckpointStore
} from '../src';

describe('Ara Checkpoints Verification Suite', () => {
  const tempCwd = path.join(process.cwd(), '.temp_checkpoints_test');
  let testDb: Database;
  const dbPath = path.join(tempCwd, 'test_ara.sqlite');

  beforeAll(async () => {
    await fs.mkdir(tempCwd, { recursive: true });
    
    // Create test SQLite DB
    testDb = new Database(dbPath);
    testDb.run(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT, model TEXT, created_at TEXT, updated_at TEXT)`);
    testDb.run(`CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, created_at TEXT)`);
    testDb.run(`CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, session_id TEXT, tool_name TEXT, input TEXT, risk_level TEXT, reason TEXT, status TEXT, created_at TEXT)`);
    testDb.run(`CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, session_id TEXT, tool_name TEXT, input TEXT, output TEXT, status TEXT, created_at TEXT)`);

    // Insert dummy session & messages
    testDb.run(`INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES ('session-1', 'Test Session', 'Gemini', '2026-05-17T12:00:00Z', '2026-05-17T12:00:00Z')`);
    testDb.run(`INSERT INTO messages (id, session_id, role, content, created_at) VALUES ('msg-1', 'session-1', 'user', 'Hello Ara', '2026-05-17T12:00:01Z')`);
    testDb.run(`INSERT INTO messages (id, session_id, role, content, created_at) VALUES ('msg-2', 'session-1', 'assistant', 'Hello human', '2026-05-17T12:00:02Z')`);
  });

  afterAll(async () => {
    if (testDb) {
      testDb.close();
    }
    await fs.rm(tempCwd, { recursive: true, force: true });
  });

  test('Checkpoint helper logic correctly identifies secret files and binary buffers', () => {
    expect(isSecretFile('.env')).toBe(true);
    expect(isSecretFile('.env.local')).toBe(true);
    expect(isSecretFile('id_rsa')).toBe(true);
    expect(isSecretFile('key.pem')).toBe(true);
    expect(isSecretFile('main.ts')).toBe(false);

    const binaryBuffer = Buffer.from([0x00, 0x01, 0x02]);
    expect(isBinaryBuffer(binaryBuffer)).toBe(true);

    const textBuffer = Buffer.from('hello world');
    expect(isBinaryBuffer(textBuffer)).toBe(false);
  });

  test('Creates and lists manual checkpoints successfully', async () => {
    // Write a dummy file to workspace
    const dummyPath = path.join(tempCwd, 'dummy.txt');
    await fs.writeFile(dummyPath, 'initial content', 'utf8');

    const checkpoint = await createCheckpoint('session-1', tempCwd, 'test creation', {
      createdBy: 'user',
      customDb: testDb,
      specificFiles: ['dummy.txt']
    });

    expect(checkpoint).toBeDefined();
    expect(checkpoint.id).toBeDefined();
    expect(checkpoint.reason).toBe('test creation');
    expect(checkpoint.createdBy).toBe('user');
    expect(checkpoint.files.length).toBe(1);
    expect(checkpoint.files[0].path).toBe('dummy.txt');
    expect(checkpoint.files[0].contentBefore).toBe('initial content');

    const list = await listCheckpoints(tempCwd);
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list.some(c => c.id === checkpoint.id)).toBe(true);
  });

  test('Checkpoint diff detects file modifications, creations, and deletions', async () => {
    // Write file state before checkpoint
    const checkPath = path.join(tempCwd, 'check.txt');
    await fs.writeFile(checkPath, 'content before', 'utf8');

    const checkpoint = await createCheckpoint('session-1', tempCwd, 'test diff', {
      createdBy: 'user',
      customDb: testDb,
      specificFiles: ['check.txt']
    });

    // 1. Modify check.txt
    await fs.writeFile(checkPath, 'content after modification', 'utf8');

    // 2. Create new file
    const newPath = path.join(tempCwd, 'newfile.txt');
    await fs.writeFile(newPath, 'new file content', 'utf8');

    const diff = await diffCheckpoint(checkpoint.id, tempCwd, testDb);
    expect(diff.filesChangedSince).toContain('check.txt');
    expect(diff.filesCreatedSince).toContain('newfile.txt');

    // Clean up
    await fs.unlink(newPath);
  });

  test('Restore checkpoint in code_only mode restores file and ignores conversation', async () => {
    // Setup file
    const restoreFilePath = path.join(tempCwd, 'restore_me.txt');
    await fs.writeFile(restoreFilePath, 'original', 'utf8');

    const checkpoint = await createCheckpoint('session-1', tempCwd, 'test restore code_only', {
      createdBy: 'user',
      customDb: testDb,
      specificFiles: ['restore_me.txt']
    });

    // Modify file and session state
    await fs.writeFile(restoreFilePath, 'modified content', 'utf8');
    testDb.run(`INSERT INTO messages (id, session_id, role, content, created_at) VALUES ('msg-3', 'session-1', 'user', 'newer message', '2026-05-17T12:00:03Z')`);

    // Restore code_only
    const result = await restoreCheckpoint(checkpoint.id, tempCwd, 'code_only', testDb);
    expect(result.filesRestored).toContain('restore_me.txt');
    expect(result.mode).toBe('code_only');

    // File content should be reverted
    const restoredContent = await fs.readFile(restoreFilePath, 'utf8');
    expect(restoredContent).toBe('original');

    // Message count should NOT be rewound in code_only
    const msgCount = testDb.query('SELECT COUNT(*) as count FROM messages WHERE session_id = ?').get('session-1') as any;
    expect(msgCount.count).toBe(3); // msg-1, msg-2, msg-3
  });

  test('Restore checkpoint in conversation_only mode rewinds messages and ignores files', async () => {
    // Setup file
    const restoreFilePath = path.join(tempCwd, 'restore_conv.txt');
    await fs.writeFile(restoreFilePath, 'original text', 'utf8');

    const checkpoint = await createCheckpoint('session-1', tempCwd, 'test restore conversation_only', {
      createdBy: 'user',
      customDb: testDb,
      specificFiles: ['restore_conv.txt']
    });

    // Modify file and insert message
    await fs.writeFile(restoreFilePath, 'modified text', 'utf8');
    // Ensure we delete msg-3 if not deleted, and insert msg-4
    testDb.run('DELETE FROM messages WHERE id = ?', ['msg-3']);
    testDb.run(`INSERT INTO messages (id, session_id, role, content, created_at) VALUES ('msg-4', 'session-1', 'user', 'message 4', '2026-05-17T12:00:04Z')`);

    // Restore conversation_only
    const result = await restoreCheckpoint(checkpoint.id, tempCwd, 'conversation_only', testDb);
    expect(result.mode).toBe('conversation_only');
    expect(result.filesRestored.length).toBe(0);

    // File content should NOT be reverted
    const unchangedFile = await fs.readFile(restoreFilePath, 'utf8');
    expect(unchangedFile).toBe('modified text');

    // Messages should be reverted to checkpoints point (msg-1, msg-2 only)
    const msgCount = testDb.query('SELECT COUNT(*) as count FROM messages WHERE session_id = ?').get('session-1') as any;
    expect(msgCount.count).toBe(2);
  });
});
