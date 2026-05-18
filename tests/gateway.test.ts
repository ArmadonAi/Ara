import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Protocol tests ──────────────────────────────────────────────

describe('Protocol', () => {
  // Dynamic imports to get fresh module state per describe block
  // We test the protocol functions after importing them

  test('registerMethod and handleRequest - success', async () => {
    const { registerMethod, handleRequest } = await import('../apps/api/src/protocol');

    registerMethod('test.echo', (params: any) => params);

    const res = await handleRequest({
      type: 'req',
      id: '1',
      method: 'test.echo',
      params: { hello: 'world' },
    });

    expect(res.type).toBe('res');
    expect(res.id).toBe('1');
    expect(res.ok).toBe(true);
    expect(res.payload).toEqual({ hello: 'world' });
  });

  test('handleRequest - unknown method', async () => {
    const { handleRequest } = await import('../apps/api/src/protocol');

    const res = await handleRequest({
      type: 'req',
      id: '42',
      method: 'does.not.exist',
    });

    expect(res.ok).toBe(false);
    expect(res.error).toContain('Unknown method');
    expect(res.id).toBe('42');
  });

  test('handleRequest - handler throws', async () => {
    const { registerMethod, handleRequest } = await import('../apps/api/src/protocol');

    registerMethod('test.error', () => {
      throw new Error('oops');
    });

    const res = await handleRequest({
      type: 'req',
      id: '3',
      method: 'test.error',
    });

    expect(res.ok).toBe(false);
    expect(res.error).toBe('oops');
  });

  test('createEvent returns structured event', async () => {
    const { createEvent } = await import('../apps/api/src/protocol');

    const event = createEvent('test.event', { data: 123 });

    expect(event.type).toBe('event');
    expect(event.event).toBe('test.event');
    expect(event.payload).toEqual({ data: 123 });
    expect(event.timestamp).toBeDefined();
    expect(() => new Date(event.timestamp)).not.toThrow();
  });
});

// ─── Gateway tests ────────────────────────────────────────────────

describe('Gateway', () => {
  test('register and getStatus', async () => {
    const { Gateway } = await import('../apps/api/src/gateway');

    const gw = new Gateway();

    // Register a mock channel
    const mockChannel = {
      name: 'mock',
      start: async () => {},
      stop: () => {},
      status: () => ({
        name: 'mock',
        running: true,
        healthy: true,
        info: { key: 'val' },
      }),
    };

    gw.register(mockChannel);
    const status = gw.getStatus();

    expect(status).toHaveLength(1);
    expect(status[0].name).toBe('mock');
    expect(status[0].running).toBe(true);
  });

  test('getChannel returns registered channel', async () => {
    const { Gateway } = await import('../apps/api/src/gateway');

    const gw = new Gateway();
    const mockChannel = {
      name: 'test-ch',
      start: async () => {},
      stop: () => {},
      status: () => ({ name: 'test-ch', running: false, healthy: false, info: {} }),
    };

    gw.register(mockChannel);
    expect(gw.getChannel('test-ch')).toBe(mockChannel);
    expect(gw.getChannel('nonexistent')).toBeUndefined();
  });

  test('startAll and stopAll', async () => {
    const { Gateway } = await import('../apps/api/src/gateway');

    const gw = new Gateway();
    let started = false;
    let stopped = false;

    gw.register({
      name: 'test',
      start: async () => { started = true; },
      stop: () => { stopped = true; },
      status: () => ({ name: 'test', running: started, healthy: started, info: {} }),
    });

    await gw.startAll();
    expect(started).toBe(true);

    gw.stopAll();
    expect(stopped).toBe(true);
  });

  test('broadcast sends to all clients', async () => {
    const { Gateway } = await import('../apps/api/src/gateway');

    const gw = new Gateway();
    const messages: string[] = [];

    // Manually add a mock client (handleWsUpgrade normally does this)
    const mockWs = {
      send: (msg: string) => { messages.push(msg); },
      addEventListener: () => {},
    } as any;

    // We need to access the private clients map through handleWsUpgrade
    // Instead, let's test broadcast by injecting a known client
    // @ts-ignore - testing internals
    gw['clients'].set('test-client', { id: 'test-client', socket: mockWs });

    gw.broadcast('test.event', { msg: 'hello' });

    expect(messages).toHaveLength(1);
    const parsed = JSON.parse(messages[0]);
    expect(parsed.type).toBe('event');
    expect(parsed.event).toBe('test.event');
    expect(parsed.payload).toEqual({ msg: 'hello' });
  });
});

// ─── Telegram config tests ───────────────────────────────────────

describe('Telegram Config', () => {
  const testDir = path.join(os.tmpdir(), 'ara-tg-test-' + Date.now());
  const originalCwd = process.cwd;

  beforeEach(() => {
    fs.mkdirSync(path.join(testDir, '.ara'), { recursive: true });
    process.cwd = () => testDir;
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    process.cwd = originalCwd;
  });

  test('creates default config file if missing', async () => {
    const cfgPath = path.join(testDir, '.ara', 'telegram.json');
    expect(fs.existsSync(cfgPath)).toBe(false);

    // Import and call loadConfig to trigger auto-creation
    const tg = await import('../apps/api/src/telegram');
    tg.loadConfig();

    expect(fs.existsSync(cfgPath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    expect(content.enabled).toBe(true);
    expect(content.botToken).toBe('');
    expect(content.groupPolicy).toBe('disabled');
  });

  test('reads existing config file and falls back to env vars', async () => {
    const cfgPath = path.join(testDir, '.ara', 'telegram.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      botToken: '',
      enabled: true,
      allowFrom: [],
      groupPolicy: 'allowlist',
      groups: {},
      streaming: true,
    }));

    // Set env var fallback
    process.env.TELEGRAM_BOT_TOKEN = 'env:token';
    const { loadConfig } = await import('../apps/api/src/telegram');
    const cfg = loadConfig();

    // Should use env var since config has empty token
    expect(cfg.botToken).toBe('env:token');
    expect(cfg.groupPolicy).toBe('allowlist');
    expect(cfg.enabled).toBe(true);

    delete process.env.TELEGRAM_BOT_TOKEN;
  });
});

// ─── LINE config tests ───────────────────────────────────────

describe('LINE Config', () => {
  const testDir = path.join(os.tmpdir(), 'ara-line-test-' + Date.now());
  const originalCwd = process.cwd;

  beforeEach(() => {
    fs.mkdirSync(path.join(testDir, '.ara'), { recursive: true });
    process.cwd = () => testDir;
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    process.cwd = originalCwd;
  });

  test('creates default config file if missing', async () => {
    const cfgPath = path.join(testDir, '.ara', 'line.json');
    expect(fs.existsSync(cfgPath)).toBe(false);

    const line = await import('../apps/api/src/line');
    line.loadConfig();

    expect(fs.existsSync(cfgPath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    expect(content.enabled).toBe(true);
    expect(content.channelAccessToken).toBe('');
    expect(content.groupPolicy).toBe('disabled');
  });
});

// ─── Channel interface tests ──────────────────────────────────────

describe('Channel Interface', () => {
  test('TelegramChannel implements Channel', async () => {
    const { TelegramChannel } = await import('../apps/api/src/telegram');

    const ch = new TelegramChannel({} as any, {} as any);
    expect(ch.name).toBe('telegram');
    expect(typeof ch.start).toBe('function');
    expect(typeof ch.stop).toBe('function');
    expect(typeof ch.status).toBe('function');
  });

  test('LineChannel implements Channel', async () => {
    const { LineChannel } = await import('../apps/api/src/line');

    const ch = new LineChannel({} as any, {} as any);
    expect(ch.name).toBe('line');
    expect(typeof ch.start).toBe('function');
    expect(typeof ch.stop).toBe('function');
    expect(typeof ch.status).toBe('function');
  });

  test('LineChannel status with no token', async () => {
    const { LineChannel } = await import('../apps/api/src/line');

    const ch = new LineChannel({} as any, {} as any);
    const st = ch.status();
    expect(st.name).toBe('line');
    // Without config file or env vars, should show not running
    expect(st.info).toBeDefined();
  });
});

// ─── Gateway singleton tests ──────────────────────────────────────

describe('Gateway Singleton', () => {
  test('getGateway returns same instance', async () => {
    const { getGateway, resetGateway } = await import('../apps/api/src/gateway');

    const g1 = getGateway();
    const g2 = getGateway();
    expect(g1).toBe(g2);

    resetGateway();
  });

  test('resetGateway creates new instance on next getGateway', async () => {
    const { getGateway, resetGateway } = await import('../apps/api/src/gateway');

    const g1 = getGateway();
    resetGateway();
    const g2 = getGateway();
    expect(g1).not.toBe(g2);

    resetGateway();
  });
});
