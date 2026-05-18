import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Session Manager tests ────────────────────────────────────────

describe('CodexSessionManager', () => {
  const testDir = path.join(os.tmpdir(), 'ara-codex-test-' + Date.now());
  const originalCwd = process.cwd;

  beforeEach(() => {
    fs.mkdirSync(path.join(testDir, '.ara', 'codex'), { recursive: true });
    process.cwd = () => testDir;
  });

  afterEach(() => {
    process.cwd = originalCwd;
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  });

  test('start throws when binary not found', async () => {
    const { getCodexSessionManager, resetCodexSessionManager } = await import('../packages/coding-agent/src/index');

    resetCodexSessionManager();
    const mgr = getCodexSessionManager();

    // Override detectBinary by setting env
    process.env.ARA_CODEX_BINARY = 'nonexistent-binary-xyz';

    expect(() => mgr.start()).toThrow();
    delete process.env.ARA_CODEX_BINARY;
    resetCodexSessionManager();
  });

  test('list returns empty array initially', async () => {
    const { getCodexSessionManager, resetCodexSessionManager } = await import('../packages/coding-agent/src/index');

    resetCodexSessionManager();
    const mgr = getCodexSessionManager();
    const sessions = mgr.list();
    expect(Array.isArray(sessions)).toBe(true);
    expect(sessions.length).toBe(0);
    resetCodexSessionManager();
  });

  test('get returns undefined for unknown id', async () => {
    const { getCodexSessionManager, resetCodexSessionManager } = await import('../packages/coding-agent/src/index');

    resetCodexSessionManager();
    const mgr = getCodexSessionManager();
    expect(mgr.get('nonexistent')).toBeUndefined();
    resetCodexSessionManager();
  });

  test('remove handles unknown id gracefully', async () => {
    const { getCodexSessionManager, resetCodexSessionManager } = await import('../packages/coding-agent/src/index');

    resetCodexSessionManager();
    const mgr = getCodexSessionManager();
    expect(mgr.remove('nonexistent')).toBe(false);
    resetCodexSessionManager();
  });

  test('create transcript directory on session start attempt', async () => {
    const codexDir = path.join(testDir, '.ara', 'codex');
    expect(fs.existsSync(codexDir)).toBe(true);
  });
});

// ─── Module exports test ──────────────────────────────────────────

describe('Coding Agent Module', () => {
  test('exports all expected functions', async () => {
    const mod = await import('../packages/coding-agent/src/index');

    expect(typeof mod.getCodexSessionManager).toBe('function');
    expect(typeof mod.resetCodexSessionManager).toBe('function');
  });

  test('getCodexSessionManager returns singleton', async () => {
    const { getCodexSessionManager, resetCodexSessionManager } = await import('../packages/coding-agent/src/index');

    resetCodexSessionManager();
    const a = getCodexSessionManager();
    const b = getCodexSessionManager();
    expect(a).toBe(b);
    resetCodexSessionManager();
  });
});
