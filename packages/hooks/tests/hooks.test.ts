import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Database } from 'bun:sqlite';
import {
  loadHookConfig,
  SettingsSchema,
  runCommandHook,
  runHttpHook,
  runHooks,
  createHookEventPayload,
  listHookAuditLogs,
  resetAuditDbInstance
} from '../src/index';

describe('Ara Hooks System - Unit Verification Suite', () => {
  const testDbPath = 'test-hooks.sqlite';
  const testCwd = path.join(process.cwd(), 'test-hooks-temp');

  beforeAll(() => {
    if (!fs.existsSync(testCwd)) {
      fs.mkdirSync(testCwd, { recursive: true });
    }
    const dotAra = path.join(testCwd, '.ara');
    if (!fs.existsSync(dotAra)) {
      fs.mkdirSync(dotAra, { recursive: true });
    }

    // Write platform-independent test runner script files
    fs.writeFileSync(
      path.join(testCwd, 'echo-stdin.ts'),
      `import * as fs from 'node:fs';\nconsole.log(fs.readFileSync(0, 'utf8'));\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(testCwd, 'sleep.ts'),
      `setTimeout(() => {}, 5000);\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(testCwd, 'huge.ts'),
      `console.log('A'.repeat(10000));\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(testCwd, 'exit-two.ts'),
      `process.exit(2);\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(testCwd, 'json-override.ts'),
      `console.log(JSON.stringify({ decision: 'block', reason: 'Custom block reason' }));\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(testCwd, 'pre-check-1.ts'),
      `console.log('first running');\n`,
      'utf8'
    );
  });

  beforeEach(() => {
    // Delete database to keep tests isolated
    try {
      fs.unlinkSync(testDbPath);
    } catch (e) {}
    resetAuditDbInstance();
  });

  afterAll(() => {
    try {
      fs.rmSync(testCwd, { recursive: true, force: true });
    } catch (e) {}
    try {
      fs.unlinkSync(testDbPath);
    } catch (e) {}
  });

  test('Valid Hook Configuration matches Zod schema', () => {
    const validConfig = {
      hooks: {
        PreToolUse: [
          {
            name: 'check-risk',
            type: 'command',
            matcher: 'run_shell',
            command: 'bun check-risk.ts',
            timeoutMs: 5000
          }
        ]
      }
    };
    const parsed = SettingsSchema.safeParse(validConfig);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.hooks.PreToolUse.length).toBe(1);
    expect(parsed.data?.hooks.PreToolUse[0].type).toBe('command');
  });

  test('Invalid Hook Configuration does not crash Ara, returns readable diagnostics', () => {
    const invalidConfigPath = path.join(testCwd, '.ara', 'settings.json');
    const invalidData = {
      hooks: {
        PreToolUse: [
          {
            name: '', // Empty name violates schema
            type: 'command',
            command: '' // Empty command violates schema
          }
        ]
      }
    };
    fs.writeFileSync(invalidConfigPath, JSON.stringify(invalidData), 'utf8');

    const config = loadHookConfig(testCwd);
    expect(config.hooks.PreToolUse.length).toBe(0);
    expect(config.diagnostics).toBeDefined();
    expect(config.diagnostics).toContain('Hook Configuration Warning');
  });

  test('Command Hook receives scrubbed JSON via stdin and processes successfully', async () => {
    const payload = createHookEventPayload('PreToolUse', 'session-stdin-test', 'default', {
      toolName: 'run_shell',
      toolInput: { command: 'hello' }
    });

    const config: any = {
      name: 'stdin-echo',
      type: 'command',
      command: 'bun echo-stdin.ts',
      timeoutMs: 5000
    };

    const res = await runCommandHook(config, payload, testCwd);
    expect(res.result.decision).toBe('continue');
    expect(res.output).toContain('session-stdin-test');
    expect(res.output).toContain('run_shell');
  });

  test('Command Hook Timeout is strictly enforced', async () => {
    const config: any = {
      name: 'sleep-timeout',
      type: 'command',
      command: 'bun sleep.ts',
      timeoutMs: 500
    };

    const payload = createHookEventPayload('PreToolUse', 'session-timeout', 'default');
    const res = await runCommandHook(config, payload, testCwd);
    expect(res.result.decision).toBe('warn');
    expect(res.result.reason).toContain('timed out');
  });

  test('Command Hook Output Truncation restricts huge output logs', async () => {
    const config: any = {
      name: 'huge-output',
      type: 'command',
      command: 'bun huge.ts',
      timeoutMs: 5000
    };

    const payload = createHookEventPayload('PreToolUse', 'session-huge', 'default');
    const res = await runCommandHook(config, payload, testCwd);
    expect(res.output.length).toBeLessThan(6000);
    expect(res.output).toContain('[Output Truncated]');
  });

  test('Command Hook Exit Code 2 triggers explicit block of tool execution', async () => {
    const config: any = {
      name: 'exit-code-two-block',
      type: 'command',
      command: 'bun exit-two.ts',
      timeoutMs: 5000
    };

    const payload = createHookEventPayload('PreToolUse', 'session-block-exit', 'default');
    const res = await runCommandHook(config, payload, testCwd);
    expect(res.result.decision).toBe('block');
    expect(res.result.reason).toContain('exit code 2');
  });

  test('Command Hook JSON response override decision', async () => {
    const config: any = {
      name: 'json-override',
      type: 'command',
      command: 'bun json-override.ts',
      timeoutMs: 5000
    };

    const payload = createHookEventPayload('PreToolUse', 'session-block-json', 'default');
    const res = await runCommandHook(config, payload, testCwd);
    expect(res.result.decision).toBe('block');
    expect(res.result.reason).toBe('Custom block reason');
  });

  test('Command Hook is blocked when command itself is denied by Permission Engine', async () => {
    const command = `rm -rf /`;
    const config: any = {
      name: 'dangerous-command-hook',
      type: 'command',
      command,
      timeoutMs: 5000
    };

    const payload = createHookEventPayload('PreToolUse', 'session-perm-deny', 'plan');
    const res = await runCommandHook(config, payload, testCwd);
    expect(res.result.decision).toBe('block');
    expect(res.result.reason).toContain('Hook execution blocked by Permission Engine policy');
  });

  test('HTTP Hook handles success and parses decision correctly', async () => {
    const originalFetch = (global as any).fetch;
    (global as any).fetch = async (url: any, options: any) => {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ decision: 'block', reason: 'Blocked by mock HTTP Hook' })
      } as any;
    };

    try {
      const config: any = {
        name: 'http-guard',
        type: 'http',
        url: 'https://security-hook-service.local/evaluate',
        timeoutMs: 5000
      };

      const payload = createHookEventPayload('PreToolUse', 'session-http', 'default');
      const res = await runHttpHook(config, payload);
      expect(res.result.decision).toBe('block');
      expect(res.result.reason).toBe('Blocked by mock HTTP Hook');
    } finally {
      (global as any).fetch = originalFetch;
    }
  });

  test('HTTP Hook Timeout is handled cleanly', async () => {
    const originalFetch = (global as any).fetch;
    (global as any).fetch = async (url: any, options: any) => {
      return new Promise((_, reject) => {
        if (options.signal) {
          options.signal.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }
      });
    };

    try {
      const config: any = {
        name: 'http-timeout',
        type: 'http',
        url: 'https://security-hook-service.local/evaluate',
        timeoutMs: 100
      };

      const payload = createHookEventPayload('PreToolUse', 'session-http-timeout', 'default');
      const res = await runHttpHook(config, payload);
      expect(res.result.decision).toBe('warn');
      expect(res.result.reason).toContain('timed out');
    } finally {
      (global as any).fetch = originalFetch;
    }
  });

  test('runHooks Orchestrator runs sequences, halts on blocks, and creates audit log records', async () => {
    const settingsPath = path.join(testCwd, '.ara', 'settings.json');
    const settingsData = {
      hooks: {
        PreToolUse: [
          {
            name: 'pre-check-1',
            type: 'command',
            command: `bun pre-check-1.ts`,
            timeoutMs: 5000
          },
          {
            name: 'pre-check-2',
            type: 'command',
            command: `bun exit-two.ts`,
            timeoutMs: 5000
          },
          {
            name: 'pre-check-3',
            type: 'command',
            command: `bun pre-check-1.ts`,
            timeoutMs: 5000
          }
        ]
      }
    };
    fs.writeFileSync(settingsPath, JSON.stringify(settingsData), 'utf8');

    const payload = createHookEventPayload('PreToolUse', 'orchestrator-session', 'default', {
      toolName: 'run_shell',
      toolInput: { command: 'npm install' }
    });

    const res = await runHooks('PreToolUse', payload, testCwd, testDbPath);
    expect(res.decision).toBe('block');

    const logs = listHookAuditLogs('orchestrator-session', testDbPath);
    expect(logs.length).toBe(2);
    expect(logs[0].hookName).toBe('pre-check-2');
    expect(logs[0].decision).toBe('block');
    expect(logs[1].hookName).toBe('pre-check-1');
    expect(logs[1].decision).toBe('continue');
  });
});
