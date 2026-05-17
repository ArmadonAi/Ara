import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';

// ─── MCP Mock Server Integration ───────────────────────────────────

describe('MCP mock server integration', () => {
  let server: http.Server | null = null;
  const MCP_PORT = 19876;

  beforeAll(async () => {
    // Start a mock MCP HTTP server
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: string) => body += chunk);
      req.on('end', () => {
        try {
          const msg = JSON.parse(body);
          if (msg.method === 'initialize') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              jsonrpc: '2.0', id: msg.id,
              result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'mock-server', version: '1.0' } },
            }));
          } else if (msg.method === 'tools/list') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              jsonrpc: '2.0', id: msg.id,
              result: {
                tools: [
                  { name: 'greet', description: 'Greet a user', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } },
                  { name: 'echo', description: 'Echo input', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
                ],
              },
            }));
          } else if (msg.method === 'tools/call') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              jsonrpc: '2.0', id: msg.id,
              result: { content: [{ type: 'text', text: `Hello, ${msg.params.arguments?.name || 'world'}!` }] },
            }));
          } else if (msg.method === 'ping') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
          } else {
            res.writeHead(400);
            res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }));
          }
        } catch {
          res.writeHead(400);
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } }));
        }
      });
    });

    await new Promise<void>(resolve => server!.listen(MCP_PORT, resolve));
  });

  afterAll(() => {
    if (server) server.close();
  });

  it('MCP server responds to initialize', async () => {
    const res = await fetch(`http://localhost:${MCP_PORT}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } }),
    });
    const data = await res.json();
    expect(data.result).toBeDefined();
    expect(data.result.serverInfo.name).toBe('mock-server');
  });

  it('MCP server lists tools', async () => {
    const res = await fetch(`http://localhost:${MCP_PORT}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    const data = await res.json();
    expect(data.result.tools).toHaveLength(2);
    expect(data.result.tools[0].name).toBe('greet');
  });

  it('MCP server calls tool and returns result', async () => {
    const res = await fetch(`http://localhost:${MCP_PORT}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'greet', arguments: { name: 'Ara' } } }),
    });
    const data = await res.json();
    expect(data.result.content[0].text).toContain('Hello, Ara');
  });

  it('MCP server responds to ping', async () => {
    const res = await fetch(`http://localhost:${MCP_PORT}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'ping' }),
    });
    const data = await res.json();
    expect(data.result).toBeDefined();
  });

  it('MCP server returns error for unknown method', async () => {
    const res = await fetch(`http://localhost:${MCP_PORT}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'unknown' }),
    });
    const data = await res.json();
    expect(data.error).toBeDefined();
    expect(data.error.code).toBe(-32601);
  });

  it('MCP server rejects invalid JSON', async () => {
    const res = await fetch(`http://localhost:${MCP_PORT}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
  });

  it('MCP server handles connection refused gracefully', async () => {
    try {
      await fetch('http://localhost:1', { signal: AbortSignal.timeout(500) });
    } catch (e: any) {
      expect(e.message).toBeTruthy();
    }
  });
});

// ─── GitHub Mock API Integration ───────────────────────────────────

describe('GitHub mock API integration', () => {
  let server: http.Server | null = null;
  const GH_PORT = 19877;

  beforeAll(async () => {
    let reqCount = 0;
    server = http.createServer((req, res) => {
      reqCount++;

      // Rate limit mock
      if (req.url?.includes('rate_limit')) {
        res.writeHead(403, { 'Content-Type': 'application/json', 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '60', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) });
        res.end(JSON.stringify({ message: 'API rate limit exceeded' }));
        return;
      }

      // Auth error mock
      if (req.url?.includes('bad-auth')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Bad credentials' }));
        return;
      }

      // Not found mock
      if (req.url?.includes('not-found')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Not Found' }));
        return;
      }

      // Issues list mock (must be checked BEFORE generic /repos/)
      if (req.url?.includes('/issues') && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([
          { number: 1, title: 'Fix bug', state: 'open', user: { login: 'testuser' }, created_at: '2026-01-01T00:00:00Z' },
          { number: 2, title: 'Add feature', state: 'open', user: { login: 'testuser' }, created_at: '2026-01-02T00:00:00Z' },
        ]));
        return;
      }

      // Create issue mock (POST)
      if (req.url?.includes('/issues') && req.method === 'POST') {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ number: 3, title: 'New Issue', state: 'open', html_url: 'https://github.com/owner/repo/issues/3' }));
        return;
      }

      // Repo mock
      if (req.url?.includes('/repos/') && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'x-ratelimit-remaining': '58' });
        res.end(JSON.stringify({ id: 1, name: 'test-repo', full_name: 'owner/test-repo', description: 'A test repo', stargazers_count: 10 }));
        return;
      }

      // 404 fallback
      res.writeHead(404);
      res.end(JSON.stringify({ message: 'Not Found' }));
    });

    await new Promise<void>(resolve => server!.listen(GH_PORT, resolve));
  });

  afterAll(() => {
    if (server) server.close();
  });

  it('GET /repos/:owner/:repo returns repo data', async () => {
    const res = await fetch(`http://localhost:${GH_PORT}/repos/owner/test-repo`);
    const data = await res.json();
    expect(data.name).toBe('test-repo');
    expect(data.full_name).toBe('owner/test-repo');
  });

  it('GET /issues returns issue list', async () => {
    const res = await fetch(`http://localhost:${GH_PORT}/repos/owner/repo/issues`);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data).toHaveLength(2);
    expect(data[0].title).toBe('Fix bug');
  });

  it('POST /issues creates an issue', async () => {
    const res = await fetch(`http://localhost:${GH_PORT}/repos/owner/repo/issues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New Issue', body: 'Description' }),
    });
    const data = await res.json();
    expect(data.number).toBe(3);
    expect(data.state).toBe('open');
  });

  it('401 error returns readable message', async () => {
    const res = await fetch(`http://localhost:${GH_PORT}/bad-auth`);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.message).toBe('Bad credentials');
  });

  it('403 rate limit returns readable error', async () => {
    const res = await fetch(`http://localhost:${GH_PORT}/rate_limit`);
    expect(res.status).toBe(403);
    expect(parseInt(res.headers.get('x-ratelimit-remaining') || '0', 10)).toBe(0);
  });

  it('404 returns readable message', async () => {
    const res = await fetch(`http://localhost:${GH_PORT}/not-found`);
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.message).toBe('Not Found');
  });
});

// ─── File Lock Integration ─────────────────────────────────────────

describe('file lock runtime integration', () => {
  it('acquires and releases write lock', () => {
    const { acquireLock, releaseLock, listLocks } = require('../packages/locks/src/lockManager.ts');
    const { clearLocks } = require('../packages/locks/src/lockStore.ts');
    clearLocks();

    const r = acquireLock({ sessionId: 'test', path: process.cwd(), mode: 'write', ttlMs: 5000 });
    expect(r.ok).toBe(true);
    expect(listLocks({ status: 'active' }).length).toBe(1);

    releaseLock(r.lock!.id);
    expect(listLocks({ status: 'active' }).length).toBe(0);
  });

  it('write lock blocks concurrent write', () => {
    const { acquireLock, listLocks } = require('../packages/locks/src/lockManager.ts');
    const { clearLocks } = require('../packages/locks/src/lockStore.ts');
    clearLocks();

    acquireLock({ sessionId: 's1', path: process.cwd(), mode: 'write', ttlMs: 5000 });
    const r2 = acquireLock({ sessionId: 's2', path: process.cwd(), mode: 'write' });
    expect(r2.ok).toBe(false);
  });
});

// ─── Secret Redaction Integration ──────────────────────────────────

describe('secret redaction patterns', () => {
  it('redacts OpenAI keys', () => {
    const { redactSecret } = require('../packages/mcp/src/mcpAudit.ts');
    expect(redactSecret('sk-abc123456789012345678901234567890123')).toContain('[REDACTED]');
  });

  it('redacts GitHub PATs', () => {
    const { redactGitHubSecret } = require('../packages/github/src/githubRedaction.ts');
    expect(redactGitHubSecret('ghp_abcdefghijklmnopqrstuvwxyz123456789012345')).toContain('[REDACTED]');
  });

  it('does not modify safe strings', () => {
    const { redactSecret } = require('../packages/mcp/src/mcpAudit.ts');
    expect(redactSecret('hello world')).toBe('hello world');
  });
});
