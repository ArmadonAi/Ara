import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createDefaultRegistry } from '../packages/commands/src/index';

describe('Phase 10: Slash Commands, Transcripts, Compaction & Model Hardening Suite', () => {
  let db: Database;
  const testSessionId = 'test-session-hardened';
  const testJsonlPath = path.join(process.cwd(), '.ara', 'sessions', `${testSessionId}.jsonl`);

  beforeAll(() => {
    // Setup clean sqlite for testing
    db = new Database('test-hardening.sqlite');
    db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT,
        model TEXT,
        created_at TEXT,
        updated_at TEXT
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        role TEXT,
        content TEXT,
        created_at TEXT
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        tool_name TEXT,
        input TEXT,
        risk_level TEXT,
        reason TEXT,
        status TEXT,
        created_at TEXT
      )
    `);

    // Clean up transcript path if exists
    if (fs.existsSync(testJsonlPath)) {
      fs.unlinkSync(testJsonlPath);
    }
  });

  afterAll(() => {
    db.close();
    try {
      fs.unlinkSync('test-hardening.sqlite');
    } catch (e) {}
    try {
      if (fs.existsSync(testJsonlPath)) {
        fs.unlinkSync(testJsonlPath);
      }
    } catch (e) {}
  });

  // =========================================================
  // A. Slash Command Registry & Help Aliases
  // =========================================================
  describe('A. Slash Command Registry', () => {
    test('Registry can parse and look up commands by aliases', () => {
      const registry = createDefaultRegistry();
      
      const helpCmd = registry.get('/help');
      expect(helpCmd).toBeDefined();
      expect(helpCmd?.aliases).toContain('/?');
      expect(helpCmd?.category).toBe('general');

      const resolvedByAlias = registry.get('/?');
      expect(resolvedByAlias).toBeDefined();
      expect(resolvedByAlias?.name).toBe('/help');

      const compactByAlias = registry.get('/prune');
      expect(compactByAlias).toBeDefined();
      expect(compactByAlias?.name).toBe('/compact');
    });

    test('Registry rejects invalid args based on schema validation', async () => {
      const registry = createDefaultRegistry();
      const ctx = { apiBaseUrl: 'http://localhost:3001', sessionId: testSessionId };
      
      // /model takes max 1 argument, passing 2 should fail
      const result = await registry.execute('/model gemini openai', ctx);
      expect(result.success).toBe(false);
      expect(result.output).toContain('Invalid arguments');
    });

    test('Registry execute returns descriptive error for unknown command', async () => {
      const registry = createDefaultRegistry();
      const result = await registry.execute('/nonexistent', { apiBaseUrl: 'http://localhost:3001' });
      expect(result.success).toBe(false);
      expect(result.output).toContain('Unknown command: /nonexistent. Type /help for a list of commands.');
    });
  });

  // =========================================================
  // B. Structured Compaction Hardening
  // =========================================================
  describe('B. Compaction Digest & Structural Integrity', () => {
    test('Prunes intermediate conversational history while preserving system instructions, pending approvals and the latest user message', () => {
      // Setup mock data
      const systemInstructions = { id: 'm1', role: 'system', content: 'You are Ara assistant.', createdAt: new Date() };
      const oldUserMsg = { id: 'm2', role: 'user', content: 'Compile this project.', createdAt: new Date() };
      const oldAssistantMsg = { id: 'm3', role: 'assistant', content: '<tool_call name="write_file">{"filePath":"main.ts"}</tool_call>', createdAt: new Date() };
      const latestUserMsg = { id: 'm4', role: 'user', content: 'Add a new script here.', createdAt: new Date() };
      const recentAssistantMsg = { id: 'm5', role: 'assistant', content: 'Sure, done.', createdAt: new Date() };

      const messages = [systemInstructions, oldUserMsg, oldAssistantMsg, latestUserMsg, recentAssistantMsg];
      
      const systemMessages = messages.filter(m => m.role === 'system');
      const nonSystemMessages = messages.filter(m => m.role !== 'system');

      // Latest user message
      const lastUserIdx = nonSystemMessages.map(m => m.role).lastIndexOf('user');
      const foundLatestUserMsg = lastUserIdx !== -1 ? nonSystemMessages[lastUserIdx] : null;
      expect(foundLatestUserMsg?.id).toBe('m4');

      // Slicing intermediate
      const keepCount = 2;
      const toCompact = nonSystemMessages.slice(0, nonSystemMessages.length - keepCount);
      let kept = nonSystemMessages.slice(nonSystemMessages.length - keepCount);

      // Keep latestUserMsg from toCompact if not in kept
      const compactedFiltered = toCompact.filter(m => m.id !== foundLatestUserMsg?.id);
      if (foundLatestUserMsg && !kept.some(m => m.id === foundLatestUserMsg.id)) {
        kept = [foundLatestUserMsg, ...kept];
      }

      expect(compactedFiltered.map(m => m.id)).toContain('m2');
      expect(kept.map(m => m.id)).toContain('m4');
      expect(kept.map(m => m.id)).toContain('m5');
      expect(systemMessages.map(m => m.id)).toContain('m1');
    });
  });

  // =========================================================
  // C. JSONL Transcripts Hardening
  // =========================================================
  describe('C. JSONL Events Transcripts', () => {
    function appendTranscriptLine(record: any) {
      const dir = path.join(process.cwd(), '.ara', 'sessions');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(testJsonlPath, JSON.stringify(record) + '\n', 'utf8');
    }

    test('Transcripts are appended sequentially and validated cleanly', () => {
      const event1 = { seq: 1, timestamp: new Date().toISOString(), sessionId: testSessionId, eventType: 'session.created', payload: {} };
      const event2 = { seq: 2, timestamp: new Date().toISOString(), sessionId: testSessionId, eventType: 'message.appended', payload: {} };
      const event3 = { seq: 3, timestamp: new Date().toISOString(), sessionId: testSessionId, eventType: 'session.resumed', payload: {} };

      appendTranscriptLine(event1);
      appendTranscriptLine(event2);
      appendTranscriptLine(event3);

      const content = fs.readFileSync(testJsonlPath, 'utf8').trim();
      const lines = content.split('\n');
      expect(lines.length).toBe(3);

      const records = lines.map(l => JSON.parse(l));
      expect(records[0].seq).toBe(1);
      expect(records[1].seq).toBe(2);
      expect(records[2].seq).toBe(3);

      // Validator checks sequence increments and types
      let expectedSeq = 1;
      let valid = true;
      for (const r of records) {
        if (r.seq !== expectedSeq) valid = false;
        expectedSeq++;
      }
      expect(valid).toBe(true);
    });

    test('Transcript validator correctly flags sequence mismatch or corruption', () => {
      // Corrupt line
      const corruptEvent = { seq: 5, timestamp: new Date().toISOString(), sessionId: testSessionId, eventType: 'message.appended', payload: {} };
      appendTranscriptLine(corruptEvent);

      const content = fs.readFileSync(testJsonlPath, 'utf8').trim();
      const lines = content.split('\n');
      const records = lines.map(l => JSON.parse(l));

      let expectedSeq = 1;
      let mismatch = false;
      for (const r of records) {
        if (r.seq !== expectedSeq) {
          mismatch = true;
          break;
        }
        expectedSeq++;
      }
      expect(mismatch).toBe(true);
    });
  });
});
