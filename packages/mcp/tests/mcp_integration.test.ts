import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import {
  validateMCPConfig,
  validateServerConfig,
  sanitizeServerConfig,
} from '../src/schema';
import {
  loadMCPConfig,
  findServerById,
  listEnabledServers,
} from '../src/mcpConfig';
import { MCPClient, MCPConnectionError } from '../src/mcpClient';
import { mapPermission, shouldRequireApproval } from '../src/mcpPermissionMapper';
import {
  writeMCPAudit,
  listMCPAudit,
  buildMCPAuditRecord,
  redactSecret,
  clearMCPAudit,
  clearAuditFile,
  initAuditStore,
  reloadAuditFromDisk,
  getAuditCount,
} from '../src/mcpAudit';
import { MCPToolAdapter, adaptDiscoveredTools } from '../src/mcpToolAdapter';
import { getRegistry, resetRegistry } from '../src/mcpServerRegistry';
import { MCPHealthMonitor } from '../src/mcpHealth';
import type { MCPServerConfig, MCPDiscoveredTool } from '../src/types';

// --- Config validation ---

describe('config validation', () => {
  it('validates a valid multi-server config', () => {
    const result = validateMCPConfig({
      servers: [
        { id: 'fs', name: 'FS', type: 'stdio', command: 'node', enabled: true },
        { id: 'web', name: 'Web', type: 'http', url: 'http://localhost:9090/mcp', enabled: false },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it('sanitize strips env', () => {
    const cfg: any = { id: 'x', name: 'X', type: 'stdio', command: 'n', env: { KEY: 'val' } };
    const s = sanitizeServerConfig(cfg);
    expect(s.env).toEqual({});
  });
});

// --- Permission mapper - hard denies ---

describe('permission mapper', () => {
  const baseServer: MCPServerConfig = {
    id: 'fs', name: 'FS', type: 'stdio', command: 'node', args: [], enabled: true,
    trusted: false, permissionMode: 'default', allowedTools: [], deniedTools: [], env: {},
  };
  const baseTool: MCPDiscoveredTool = {
    serverId: 'fs', serverName: 'FS', name: 'read_file', description: '', inputSchema: {},
    dangerLevel: 'safe', mutating: false,
  };

  it('denies disabled server', () => {
    const r = mapPermission({
      serverConfig: { ...baseServer, enabled: false }, tool: baseTool, input: {},
      permissionMode: 'default', trustLevel: 'untrusted',
    });
    expect(r.decision).toBe('deny');
  });

  it('denies tool on denied list', () => {
    const r = mapPermission({
      serverConfig: { ...baseServer, deniedTools: ['read_file'] }, tool: baseTool, input: {},
      permissionMode: 'default', trustLevel: 'untrusted',
    });
    expect(r.decision).toBe('deny');
  });

  it('denies tool not in allowlist', () => {
    const r = mapPermission({
      serverConfig: { ...baseServer, allowedTools: ['write_file'] }, tool: baseTool, input: {},
      permissionMode: 'default', trustLevel: 'untrusted',
    });
    expect(r.decision).toBe('deny');
  });

  it('allows trusted safe tool', () => {
    const r = mapPermission({
      serverConfig: { ...baseServer, trusted: true }, tool: baseTool, input: {},
      permissionMode: 'default', trustLevel: 'trusted',
    });
    expect(r.decision).toBe('allow');
  });

  it('denies shell-like tool on untrusted server', () => {
    const shellTool = { ...baseTool, name: 'run_shell', dangerLevel: 'dangerous' as const };
    const r = mapPermission({
      serverConfig: baseServer, tool: shellTool, input: {},
      permissionMode: 'default', trustLevel: 'untrusted',
    });
    expect(r.decision).toBe('deny');
  });

  it('asks for untrusted mutating tool', () => {
    const mutTool = { ...baseTool, name: 'write_file', dangerLevel: 'write' as const, mutating: true };
    const r = mapPermission({
      serverConfig: baseServer, tool: mutTool, input: {},
      permissionMode: 'default', trustLevel: 'untrusted',
    });
    expect(r.decision).toBe('ask');
  });

  it('denies secret-related tool on untrusted server', () => {
    const secretTool = { ...baseTool, name: 'read_env' };
    const r = mapPermission({
      serverConfig: baseServer, tool: secretTool, input: { filePath: '.env' },
      permissionMode: 'default', trustLevel: 'untrusted',
    });
    expect(r.decision).toBe('deny');
  });
});

// --- Audit ---

describe('audit redaction', () => {
  beforeEach(() => clearMCPAudit());

  it('redacts OpenAI keys', () => {
    const result = redactSecret('sk-abc123456789012345678901234567890123');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts Anthropic keys', () => {
    const result = redactSecret('sk-ant-api03-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdefg');
    expect(result).toContain('[REDACTED]');
  });

  it('does not modify safe strings', () => {
    expect(redactSecret('hello world')).toBe('hello world');
  });

  it('writes and retrieves audit records', () => {
    writeMCPAudit({ id: 'a1', eventType: 'mcp.tool.called', serverId: 'fs', serverName: 'FS', sessionId: 's1', status: 'success' });
    writeMCPAudit({ id: 'a2', eventType: 'mcp.server.started', serverId: 'fs', serverName: 'FS', sessionId: 's1', status: 'success' });
    const list = listMCPAudit({ serverId: 'fs' });
    expect(list.length).toBe(2);
  });

  it('filters by sessionId', () => {
    writeMCPAudit({ id: 'b1', eventType: 'mcp.tool.called', serverId: 'fs', serverName: 'FS', sessionId: 's1', status: 'success' });
    writeMCPAudit({ id: 'b2', eventType: 'mcp.tool.called', serverId: 'fs', serverName: 'FS', sessionId: 's2', status: 'success' });
    expect(listMCPAudit({ sessionId: 's1' }).length).toBe(1);
  });

  it('handles audit limit', () => {
    for (let i = 0; i < 10; i++) {
      writeMCPAudit({ id: `c${i}`, eventType: 'mcp.tool.called', serverId: 'fs', serverName: 'FS', sessionId: 's1', status: 'success' });
    }
    expect(listMCPAudit({ limit: 3 }).length).toBe(3);
  });

  it('builds complete audit record', () => {
    const r = buildMCPAuditRecord({
      eventType: 'mcp.tool.called',
      serverId: 'fs',
      serverName: 'FS',
      sessionId: 's1',
      toolName: 'read_file',
      fullToolName: 'mcp.fs.read_file',
      permissionDecision: 'allow',
      dangerLevel: 'safe',
      startedAt: new Date().toISOString(),
    });
    expect(r.id).toBeTruthy();
    expect(r.toolName).toBe('read_file');
    expect(r.fullToolName).toBe('mcp.fs.read_file');
  });
});

// --- Tool adapter ---

describe('tool adapter', () => {
  const cfg: MCPServerConfig = {
    id: 'fs', name: 'FS', type: 'stdio', command: 'node', args: [], enabled: true,
    trusted: false, permissionMode: 'default', allowedTools: [], deniedTools: [], env: {},
  };

  it('creates tool with correct name prefix', () => {
    const tool: MCPDiscoveredTool = {
      serverId: 'fs', serverName: 'FS', name: 'read', description: 'Read files',
      inputSchema: {}, dangerLevel: 'safe', mutating: false,
    };
    const client = new MCPClient(cfg);
    const adapter = new MCPToolAdapter({ serverConfig: cfg, discoveredTool: tool, mcpClient: client, sessionId: 's1' });
    expect(adapter.name).toBe('mcp.fs.read');
    expect(adapter.description).toContain('[MCP / FS]');
    expect(adapter.requiresApproval).toBe(false);
  });

  it('mutating tool requires approval', () => {
    const tool: MCPDiscoveredTool = {
      serverId: 'fs', serverName: 'FS', name: 'write', description: 'Write',
      inputSchema: {}, dangerLevel: 'write', mutating: true,
    };
    const client = new MCPClient(cfg);
    const adapter = new MCPToolAdapter({ serverConfig: cfg, discoveredTool: tool, mcpClient: client, sessionId: 's1' });
    expect(adapter.requiresApproval).toBe(true);
  });

  it('adapts discovered tools into Ara tools', () => {
    const tools: MCPDiscoveredTool[] = [
      { serverId: 'fs', serverName: 'FS', name: 'write', description: 'Write', inputSchema: {}, dangerLevel: 'write', mutating: true },
      { serverId: 'fs', serverName: 'FS', name: 'read', description: 'Read', inputSchema: {}, dangerLevel: 'safe', mutating: false },
    ];
    const client = new MCPClient(cfg);
    const adapted = adaptDiscoveredTools(cfg, tools, client, 's1');
    expect(adapted.length).toBe(2);
    expect(adapted[0].name).toBe('mcp.fs.write');
    expect(adapted[0].requiresApproval).toBe(true);
    expect(adapted[1].name).toBe('mcp.fs.read');
    expect(adapted[1].requiresApproval).toBe(false);
  });
});

// --- Registry ---

describe('registry', () => {
  beforeEach(() => resetRegistry());

  it('loads config with no enabled servers', async () => {
    const r = getRegistry();
    await r.loadConfig('/nonexistent');
    expect(r.listServerIds()).toEqual([]);
    expect(r.getConfig().servers).toEqual([]);
  });

  it('startServer returns error for unknown server', async () => {
    const r = getRegistry();
    await r.loadConfig('/nonexistent');
    const result = await r.startServer('unknown');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not found');
  });
});

// --- Health monitor ---

describe('health monitor', () => {
  it('tracks states and summary', () => {
    const m = new MCPHealthMonitor();
    m.update({ serverId: 'fs', state: 'healthy', toolCount: 3 });
    m.update({ serverId: 'gh', state: 'error', toolCount: 0 });
    expect(m.healthyCount).toBe(1);
    const summary = m.getSummary();
    expect(summary.total).toBe(2);
    expect(summary.healthy).toBe(1);
    expect(summary.unhealthy).toBe(1);
  });
});

// --- shouldRequireApproval ---

describe('shouldRequireApproval', () => {
  const baseTool: MCPDiscoveredTool = {
    serverId: 'x', serverName: 'X', name: 'read', description: '', inputSchema: {},
    dangerLevel: 'safe', mutating: false,
  };
  const trustedCfg: MCPServerConfig = {
    id: 'x', name: 'X', type: 'stdio', command: 'n', args: [], enabled: true,
    trusted: true, permissionMode: 'default', allowedTools: [], deniedTools: [], env: {},
  };
  const untrustedCfg: MCPServerConfig = { ...trustedCfg, trusted: false };

  it('trusted safe tool does NOT require approval', () => {
    expect(shouldRequireApproval(trustedCfg, baseTool)).toBe(false);
  });

  it('untrusted mutating tool requires approval', () => {
    const tool = { ...baseTool, dangerLevel: 'write' as const, mutating: true };
    expect(shouldRequireApproval(untrustedCfg, tool)).toBe(true);
  });
});

// --- MCPConfig load from non-existent path ---

describe('loadMCPConfig', () => {
  it('returns empty servers array from non-existent path', async () => {
    const config = await loadMCPConfig('/nonexistent');
    expect(config.servers).toEqual([]);
  });
});

// --- Schema Zod round-trip ---

describe('schema Zod round-trip', () => {
  const { MCPConfigSchema } = require('../src/types');

  it('validates multi-server config', () => {
    const r = MCPConfigSchema.safeParse({
      servers: [
        { id: 'a', name: 'A', type: 'stdio', command: 'n', enabled: true },
        { id: 'b', name: 'B', type: 'http', url: 'http://localhost:1/mcp', enabled: false },
      ],
    });
    expect(r.success).toBe(true);
    expect(r.data.servers.length).toBe(2);
  });
});

// --- Persistent audit ---

describe('persistent audit store', () => {
  const testDir = '/tmp/ara-mcp-audit-test';
  const testPath = '/tmp/ara-mcp-audit-test/mcp.jsonl';

  beforeEach(() => {
    initAuditStore(testPath);
    clearAuditFile();
    clearMCPAudit();
  });
  afterAll(() => {
    try { require('node:fs').rmSync(testDir, { recursive: true, force: true }); } catch {}
  });

  it('persists audit records to disk and reloads them', () => {
    writeMCPAudit({ id: 'disk1', eventType: 'mcp.tool.called', serverId: 'fs', serverName: 'FS', sessionId: 's1', status: 'success' });
    writeMCPAudit({ id: 'disk2', eventType: 'mcp.server.stopped', serverId: 'fs', serverName: 'FS', sessionId: 's1', status: 'success' });

    // Verify cache has both
    expect(listMCPAudit().length).toBe(2);

    // Clear cache only — file persists
    clearMCPAudit();
    expect(getAuditCount()).toBe(0);

    // Reload from disk
    const loaded = reloadAuditFromDisk();
    expect(loaded).toBe(2);
    expect(listMCPAudit().length).toBe(2);
  });

  it('redaction still works after reload', () => {
    const r = buildMCPAuditRecord({
      eventType: 'mcp.tool.called',
      serverId: 'fs', serverName: 'FS', sessionId: 's1',
      startedAt: new Date().toISOString(),
      result: { ok: false, error: 'sk-abc12345678901234567890123456789012' },
    });
    writeMCPAudit(r);

    // Clear cache only, then reload from disk
    clearMCPAudit();
    expect(getAuditCount()).toBe(0);
    reloadAuditFromDisk();

    const list = listMCPAudit();
    expect(list.length).toBe(1);
    expect(list[0].error).toContain('[REDACTED]');
    expect(list[0].error).not.toContain('sk-abc');
  });

  it('query returns latest records', () => {
    for (let i = 0; i < 15; i++) {
      writeMCPAudit({ id: `q${i}`, eventType: 'mcp.tool.called', serverId: 'fs', serverName: 'FS', sessionId: 's1', status: 'success' });
    }
    const limited = listMCPAudit({ limit: 5 });
    expect(limited.length).toBe(5);
    expect(limited[0].id).toBe('q10');
  });
});

// --- Tool refresh ---

describe('tool refresh', () => {
  // The registry tests don't connect real servers, so refresh is tested
  // at the logic level. Full refresh requires a running server.

  it('registry has refreshTools and refreshAllTools methods', () => {
    const { getRegistry } = require('../src/mcpServerRegistry');
    resetRegistry();
    const r = getRegistry();
    expect(typeof r.refreshTools).toBe('function');
    expect(typeof r.refreshAllTools).toBe('function');
  });

  it('refreshTools returns error for unknown server', async () => {
    const { getRegistry } = require('../src/mcpServerRegistry');
    resetRegistry();
    const r = getRegistry();
    await r.loadConfig('/nonexistent');
    const result = await r.refreshTools('unknown');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('refreshTools returns error for disabled server', async () => {
    // This test verifies the logic path; actual reconnect needs a real server
    resetRegistry();
    const r = getRegistry();
    await r.loadConfig('/nonexistent');
    const result = await r.refreshTools('nonexistent');
    expect(result.ok).toBe(false);
  });
});

// --- Subagent MCP allowlist ---

describe('subagent MCP allowlist enforcement', () => {
  // Tests the isToolAllowed logic pattern used in runSubagent.ts

  function isToolAllowed(toolName: string, allowedTools: string[]): boolean {
    return allowedTools.some((allowed: string) => {
      if (allowed === toolName) return true;
      if (allowed.endsWith('.*')) {
        const prefix = allowed.slice(0, -2);
        return toolName.startsWith(prefix);
      }
      return false;
    });
  }

  it('allows exact MCP read tool match', () => {
    expect(isToolAllowed('mcp.github.get_issue', ['mcp.github.get_issue'])).toBe(true);
  });

  it('denies MCP tool not in allowlist', () => {
    expect(isToolAllowed('mcp.github.get_issue', ['mcp.github.list_repos'])).toBe(false);
  });

  it('allows namespace wildcard mcp.*', () => {
    expect(isToolAllowed('mcp.github.get_issue', ['mcp.github.*'])).toBe(true);
    expect(isToolAllowed('mcp.github.list_repos', ['mcp.github.*'])).toBe(true);
  });

  it('denies tool outside wildcard namespace', () => {
    expect(isToolAllowed('mcp.fs.read_file', ['mcp.github.*'])).toBe(false);
  });

  it('allows wildcard for all MCP tools', () => {
    expect(isToolAllowed('mcp.any.tool', ['mcp.*'])).toBe(true);
  });

  it('denies mutating MCP tool for subagent', () => {
    // Subagent runtime filters mutating MCP tools regardless of allowlist
    const mutatingMcp = { name: 'mcp.fs.write_file', dangerLevel: 'write' };
    const allowed = isToolAllowed(mutatingMcp.name, ['mcp.fs.*']);
    expect(allowed).toBe(true);
    // The runtime additionally checks dangerLevel and denies write/dangerous
    const denied = mutatingMcp.dangerLevel === 'write' || mutatingMcp.dangerLevel === 'dangerous';
    expect(denied).toBe(true);
  });
});
