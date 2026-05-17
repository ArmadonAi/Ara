import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadConfig, saveConfig, setApiBaseUrl, getApiBaseUrl } from '../src/config/manager';
import { ApiClient } from '../src/api/client';

const testConfigDir = path.join(os.homedir(), '.ara');
const testConfigFile = path.join(testConfigDir, 'config.json');

describe('Ara CLI Gateway - Audit & Verification Suite', () => {
  let originalFetch: typeof global.fetch;

  beforeAll(() => {
    originalFetch = (global as any).fetch;
  });

  afterAll(() => {
    (global as any).fetch = originalFetch;
    // Cleanup config if created by test
    try {
      if (fs.existsSync(testConfigFile)) {
        fs.unlinkSync(testConfigFile);
      }
    } catch (e) {}
  });

  // =========================================================
  // 1. Config Loader / Creator tests
  // =========================================================
  describe('Config Management', () => {
    test('Loads config and returns default values when missing', () => {
      // Force delete test config file first
      try {
        if (fs.existsSync(testConfigFile)) {
          fs.unlinkSync(testConfigFile);
        }
      } catch (e) {}

      const config = loadConfig();
      expect(config.apiBaseUrl).toBe('http://localhost:3001');
      expect(config.defaultModel).toBeNull();
      expect(config.theme).toBe('default');
    });

    test('Persists and retrieves config parameters successfully', () => {
      setApiBaseUrl('http://my-custom-api-host:3005');
      expect(getApiBaseUrl()).toBe('http://my-custom-api-host:3005');

      const config = loadConfig();
      expect(config.apiBaseUrl).toBe('http://my-custom-api-host:3005');
      
      // Restore default
      setApiBaseUrl('http://localhost:3001');
      expect(getApiBaseUrl()).toBe('http://localhost:3001');
    });
  });

  // =========================================================
  // 2. API Client Construction & Requests Mocks
  // =========================================================
  describe('ApiClient & Endpoint Mocks', () => {
    test('getStatus retrieves correctly formatted metrics', async () => {
      (global as any).fetch = async (url: any) => {
        expect(url.toString()).toContain('/api/status');
        return new Response(JSON.stringify({
          status: 'ok',
          version: '0.2.0',
          database: 'ok',
          pendingApprovalsCount: 2,
          skillsCount: 4,
          sandboxMode: false,
          memoryEnabled: true
        }), { status: 200 });
      };

      const client = new ApiClient();
      const status = await client.getStatus();
      expect(status.version).toBe('0.2.0');
      expect(status.pendingApprovalsCount).toBe(2);
      expect(status.skillsCount).toBe(4);
    });

    test('getStatus handles API offline gracefully', async () => {
      (global as any).fetch = async () => {
        throw new Error('fetch failed: Connection refused');
      };

      const client = new ApiClient();
      expect(client.getStatus()).rejects.toThrow('Connection refused');
    });

    test('getStatus handles malformed response behavior gracefully', async () => {
      (global as any).fetch = async () => {
        return new Response('Not-A-Json-String', { status: 200 });
      };

      const client = new ApiClient();
      expect(client.getStatus()).rejects.toThrow();
    });

    test('approveRequest posts action parameter correctly', async () => {
      (global as any).fetch = async (url: any, options: any) => {
        expect(url.toString()).toBe('http://localhost:3001/api/approvals/app-123/resolve');
        expect(options?.method).toBe('POST');
        const body = JSON.parse(options?.body as string);
        expect(body.action).toBe('approve');

        return new Response(JSON.stringify({ success: true, status: 'approved' }), { status: 200 });
      };

      const client = new ApiClient();
      const res = await client.approveRequest('app-123');
      expect(res.success).toBe(true);
      expect(res.status).toBe('approved');
    });

    test('rejectRequest posts action parameter correctly', async () => {
      (global as any).fetch = async (url: any, options: any) => {
        expect(url.toString()).toBe('http://localhost:3001/api/approvals/app-999/resolve');
        expect(options?.method).toBe('POST');
        const body = JSON.parse(options?.body as string);
        expect(body.action).toBe('reject');

        return new Response(JSON.stringify({ success: true, status: 'rejected' }), { status: 200 });
      };

      const client = new ApiClient();
      const res = await client.rejectRequest('app-999');
      expect(res.success).toBe(true);
      expect(res.status).toBe('rejected');
    });

    test('listMemory, listSkills, and listAuditLogs use correct URL construction', async () => {
      let callCount = 0;
      (global as any).fetch = async (url: any) => {
        callCount++;
        const path = url.toString();
        if (path.endsWith('/api/memories')) {
          return new Response(JSON.stringify([{ id: 'm1', type: 'user', title: 'Fact', content: 'Info' }]), { status: 200 });
        }
        if (path.endsWith('/api/skills')) {
          return new Response(JSON.stringify([{ name: 'Check', description: 'desc', dangerLevel: 'safe' }]), { status: 200 });
        }
        if (path.endsWith('/api/audit-logs')) {
          return new Response(JSON.stringify([{ id: 'l1', sessionId: 's1', toolName: 't', input: 'i', output: 'o', status: 'success', createdAt: '2026' }]), { status: 200 });
        }
        return new Response('[]', { status: 200 });
      };

      const client = new ApiClient();
      const memories = await client.listMemory();
      const skills = await client.listSkills();
      const logs = await client.listAuditLogs();

      expect(callCount).toBe(3);
      expect(memories[0]?.id).toBe('m1');
      expect(skills[0]?.name).toBe('Check');
      expect(logs[0]?.id).toBe('l1');
    });
  });

  // =========================================================
  // 3. SSE Stream Decoder Event translations
  // =========================================================
  describe('Stream Message SSE Translation', () => {
    test('Translates raw chunk tokens and parses tool calls', async () => {
      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('Hello, I am ready to review files.\n'));
          controller.enqueue(new TextEncoder().encode('<tool_call name="read_file">{"filePath":"package.json"}</tool_call>'));
          controller.enqueue(new TextEncoder().encode('\nawaitingApproval for dangerous action.'));
          controller.close();
        }
      });

      (global as any).fetch = async () => {
        return new Response(mockStream, { status: 200 });
      };

      const client = new ApiClient();
      const events = [];
      for await (const event of client.streamMessage('sess-1', 'Review the package file')) {
        events.push(event);
      }

      // Check text tokens yielded
      const textDeltaEvents = events.filter(e => e.type === 'message.delta');
      expect(textDeltaEvents.length).toBeGreaterThan(0);

      // Check tool call detected
      const toolStartEvent = events.find(e => e.type === 'tool.started') as any;
      expect(toolStartEvent).toBeDefined();
      expect(toolStartEvent.name).toBe('read_file');

      // Check approval required detected
      const approvalEvent = events.find(e => e.type === 'approval.required');
      expect(approvalEvent).toBeDefined();
    });

    test('streamMessage handles connection errors during stream correctly', async () => {
      (global as any).fetch = async () => {
        return new Response('Server Error', { status: 500 });
      };

      const client = new ApiClient();
      const events = [];
      for await (const event of client.streamMessage('sess-1', 'Review')) {
        events.push(event);
      }
      expect(events[0]?.type).toBe('error');
      expect((events[0] as any).message).toContain('error status 500');
    });
  });

  // =========================================================
  // 4. Slash Commands and Session APIs (Phase 14)
  // =========================================================
  describe('Slash Commands & Session API Operations', () => {
    test('Slash commands parser executes help successfully', async () => {
      const { createDefaultRegistry } = await import('@ara/commands');
      const registry = createDefaultRegistry();
      const res = await registry.execute('/help', { apiBaseUrl: 'http://localhost:3001' });
      expect(res.success).toBe(true);
      expect(res.output).toContain('Ara Slash Commands Guide');
    });

    test('Slash commands compact API call construction', async () => {
      (global as any).fetch = async (url: any, options: any) => {
        expect(url.toString()).toBe('http://localhost:3001/api/sessions/sess-123/compact');
        expect(options?.method).toBe('POST');
        return new Response(JSON.stringify({ success: true, compactedCount: 5 }), { status: 200 });
      };

      const client = new ApiClient();
      const res = await client.compactSession('sess-123');
      expect(res.success).toBe(true);
      expect(res.compactedCount).toBe(5);
    });

    test('Slash commands fork API call construction', async () => {
      (global as any).fetch = async (url: any, options: any) => {
        expect(url.toString()).toBe('http://localhost:3001/api/sessions/sess-123/fork');
        expect(options?.method).toBe('POST');
        const body = JSON.parse(options?.body as string);
        expect(body.messageIndex).toBe(3);
        return new Response(JSON.stringify({ id: 'fork-456', title: 'Forked session' }), { status: 200 });
      };

      const client = new ApiClient();
      const res = await client.forkSession('sess-123', 3);
      expect(res.id).toBe('fork-456');
    });

    test('Slash commands doctor API execution', async () => {
      (global as any).fetch = async (url: any) => {
        expect(url.toString()).toContain('/api/status');
        return new Response(JSON.stringify({
          status: 'ok',
          version: '0.2.0',
          database: 'ok',
          pendingApprovalsCount: 0,
          skillsCount: 1,
          sandboxMode: false,
          memoryEnabled: true
        }), { status: 200 });
      };

      const { createDefaultRegistry } = await import('@ara/commands');
      const registry = createDefaultRegistry();
      const res = await registry.execute('/doctor', { apiBaseUrl: 'http://localhost:3001' });
      expect(res.success).toBe(true);
      expect(res.output).toContain('ONLINE');
    });
  });
});
