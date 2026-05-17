import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import type { MCPServerConfig } from './types';

// ─── Port Scanning ─────────────────────────────────────────────────

interface PortResult {
  port: number;
  open: boolean;
  protocol?: string;
  serverInfo?: string;
}

/**
 * Scan a single port to see if it responds as an MCP HTTP server.
 */
async function scanPort(port: number, timeoutMs: number = 2000): Promise<PortResult> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`http://127.0.0.1:${port}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      try {
        const data = await res.json();
        if (data && data.result && data.result.serverInfo) {
          return { port, open: true, protocol: 'http', serverInfo: data.result.serverInfo.name || 'unknown' };
        }
        return { port, open: true, protocol: 'http', serverInfo: 'mcp-server' };
      } catch {
        return { port, open: true, protocol: 'http' };
      }
    }
    return { port, open: false };
  } catch {
    return { port, open: false };
  }
}

/**
 * Scan a range of ports for MCP HTTP servers.
 */
export async function discoverHTTPServers(
  startPort: number = 3100,
  endPort: number = 3200,
  concurrency: number = 20
): Promise<MCPServerConfig[]> {
  const found: MCPServerConfig[] = [];
  const ports: number[] = [];

  for (let p = startPort; p <= endPort; p++) ports.push(p);

  // Scan in batches for concurrency control
  for (let i = 0; i < ports.length; i += concurrency) {
    const batch = ports.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(p => scanPort(p)));
    for (const r of results) {
      if (r.open && r.protocol === 'http') {
        found.push({
          id: `discovered-${r.port}`,
          name: r.serverInfo || `MCP Server (port ${r.port})`,
          type: 'http',
          url: `http://127.0.0.1:${r.port}`,
          enabled: false, // discovered servers don't auto-start
          trusted: false,
          permissionMode: 'default',
          allowedTools: [],
          deniedTools: [],
          env: {},
          timeoutMs: 15000,
        });
      }
    }
  }

  return found;
}

// ─── Common MCP Server Patterns ───────────────────────────────────

interface KnownMCPServer {
  name: string;
  package: string;
  command: string;
  args: string[];
  description: string;
}

const KNOWN_SERVERS: KnownMCPServer[] = [
  { name: 'Filesystem', package: '@modelcontextprotocol/server-filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'], description: 'Local filesystem access' },
  { name: 'GitHub', package: '@modelcontextprotocol/server-github', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], description: 'GitHub API integration' },
  { name: 'PostgreSQL', package: '@modelcontextprotocol/server-postgres', command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres'], description: 'PostgreSQL database access' },
  { name: 'SQLite', package: '@modelcontextprotocol/server-sqlite', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sqlite'], description: 'SQLite database access' },
  { name: 'Redis', package: '@modelcontextprotocol/server-redis', command: 'npx', args: ['-y', '@modelcontextprotocol/server-redis'], description: 'Redis cache access' },
  { name: 'Playwright', package: '@modelcontextprotocol/server-playwright', command: 'npx', args: ['-y', '@modelcontextprotocol/server-playwright'], description: 'Browser automation' },
  { name: 'Memory', package: '@modelcontextprotocol/server-memory', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], description: 'Knowledge graph memory' },
  { name: 'Puppeteer', package: '@modelcontextprotocol/server-puppeteer', command: 'npx', args: ['-y', '@modelcontextprotocol/server-puppeteer'], description: 'Browser automation' },
  { name: 'Brave Search', package: '@modelcontextprotocol/server-brave-search', command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'], description: 'Web search via Brave' },
  { name: 'Fetch', package: '@modelcontextprotocol/server-fetch', command: 'npx', args: ['-y', '@modelcontextprotocol/server-fetch'], description: 'HTTP fetch capability' },
];

export function getKnownServers(): KnownMCPServer[] {
  return KNOWN_SERVERS;
}

/**
 * Install an MCP server package and return the suggested config entry.
 */
export async function installMCPServer(
  packageName: string,
  cwd: string = process.cwd()
): Promise<{ ok: boolean; config?: MCPServerConfig; error?: string }> {
  const known = KNOWN_SERVERS.find(s => s.package === packageName || s.name.toLowerCase() === packageName.toLowerCase());
  const targetName = known ? known.name : packageName.split('/').pop() || packageName;
  const targetPackage = known ? known.package : packageName;

  try {
    // Install the npm package
    execSync(`npx -y ${targetPackage} --version`, { timeout: 30000, stdio: 'pipe' });
  } catch {
    // If npx can't run it, try npm install
    try {
      execSync(`npm install -g ${targetPackage}`, { timeout: 60000, stdio: 'pipe' });
    } catch {
      return { ok: false, error: `Failed to install ${targetPackage}. Try: npm install -g ${targetPackage}` };
    }
  }

  const config: MCPServerConfig = {
    id: targetName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name: targetName,
    type: 'stdio',
    command: 'npx',
    args: ['-y', targetPackage],
    enabled: false,
    trusted: false,
    permissionMode: 'default',
    allowedTools: [],
    deniedTools: [],
    env: {},
    timeoutMs: 15000,
  };

  return { ok: true, config };
}

/**
 * Merge discovered/installed servers into an existing MCP config.
 */
export function mergeServerConfig(
  existing: { servers: MCPServerConfig[] },
  newConfig: MCPServerConfig
): { servers: MCPServerConfig[]; added: boolean } {
  const exists = existing.servers.some(s => s.id === newConfig.id);
  if (exists) return { servers: existing.servers, added: false };
  return { servers: [...existing.servers, newConfig], added: true };
}
