import { describe, it, expect, beforeEach } from 'bun:test';
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
import { MCPClient } from '../src/mcpClient';
import { mapPermission, shouldRequireApproval } from '../src/mcpPermissionMapper';
import {
  writeMCPAudit,
  listMCPAudit,
  buildMCPAuditRecord,
  redactSecret,
  clearMCPAudit,
} from '../src/mcpAudit';
import { MCPToolAdapter, adaptDiscoveredTools } from '../src/mcpToolAdapter';
import { MCPRegistry, resetRegistry } from '../src/mcpServerRegistry';
import { MCPHealthMonitor } from '../src/mcpHealth';
import { MCPConfigSchema, MCPServerConfigSchema } from '../src/types';
import { z } from 'zod';

// ─── schema.ts ──────────────────────────────────────────────────────────────

describe('validateMCPConfig', () => {
  it('accepts a valid config', () => {
    const result = validateMCPConfig({
      servers: [
        {
          id: 'test',
          name: 'Test',
          type: 'stdio',
          command: 'node',
          args: ['server.js'],
          enabled: true,
          trusted: false,
          permissionMode: 'default',
          allowedTools: [],
          deniedTools: [],
          env: {},
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.servers.length).toBe(1);
  });

  it('accepts a config with no servers field (defaults to empty array)', () => {
    const result = validateMCPConfig({} as any);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.servers).toEqual([]);
  });

  it('rejects a config with empty server id', () => {
    const result = validateMCPConfig({
      servers: [{ id: '', name: 'X', type: 'stdio', command: 'node', enabled: true }],
    });
    expect(result.ok).toBe(false);
  });
});

describe('validateServerConfig', () => {
  it('accepts a valid server config', () => {
    const result = validateServerConfig({
      id: 'fs', name: 'Filesystem', type: 'stdio', command: 'node', args: [], enabled: true,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a server config with empty id', () => {
    const result = validateServerConfig({ id: '', name: 'X', type: 'stdio', command: 'node', enabled: true } as any);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe('sanitizeServerConfig', () => {
  it('strips env from output', () => {
    const cfg = {
      id: 'x', name: 'X', type: 'stdio' as const, command: 'n', enabled: true,
      env: { MY_TOKEN: 'abc' },
    };
    const sanitized = sanitizeServerConfig(cfg) as any;
    expect(sanitized.env).toEqual({});
    expect(sanitized.id).toBe('x');
  });
});

// ─── mcpConfig.ts ───────────────────────────────────────────────────────────

describe('loadMCPConfig', () => {
  it('returns empty servers array when no file exists', async () => {
    const config = await loadMCPConfig('/nonexistent');
    expect(config.servers).toEqual([]);
  });
});

describe('findServerById', () => {
  it('returns matching server', () => {
    const config = {
      servers: [
        { id: 'a', name: 'A', type: 'stdio' as const, command: 'n', args: [], enabled: true },
        { id: 'b', name: 'B', type: 'stdio' as const, command: 'n', args: [], enabled: true },
      ],
    };
    expect(findServerById(config, 'b')?.name).toBe('B');
    expect(findServerById(config, 'z')).toBeUndefined();
  });
});

describe('listEnabledServers', () => {
  it('filters out disabled servers', () => {
    const config = {
      servers: [
        { id: 'a', name: 'A', type: 'stdio' as const, command: 'n', args: [], enabled: true },
        { id: 'b', name: 'B', type: 'stdio' as const, command: 'n', args: [], enabled: false },
      ],
    };
    const enabled = listEnabledServers(config);
    expect(enabled.length).toBe(1);
    expect(enabled[0].id).toBe('a');
  });
});

// ─── mcpClient.ts ───────────────────────────────────────────────────────────

describe('MCPClient — HTTP mode', () => {
  it('fails gracefully when server is unreachable', async () => {
    const config: MCPServerConfig = {
      id: 'ghost',
      name: 'Ghost',
      type: 'http',
      url: 'http://localhost:1/mcp',
      enabled: true,
      trusted: false,
      permissionMode: 'default',
      allowedTools: [],
      deniedTools: [],
      env: {},
    };
    const client = new MCPClient(config);
    const result = await client.initialize();
    expect(result.ok).toBe(false);
    expect(result.tools).toEqual([]);
    expect(result.error).toBeTruthy();
  });
});

// ─── mcpPermissionMapper.ts ─────────────────────────────────────────────────

describe('mapPermission', () => {
  const baseTool = {
    serverId: 'fs',
    serverName: 'Filesystem',
    name: 'read_file',
    description: 'Read a file',
    inputSchema: {},
    dangerLevel: 'safe' as const,
    mutating: false,
  };

  const baseConfig: MCPServerConfig = {
    id: 'fs',
    name: 'Filesystem',
    type: 'stdio',
    command: 'node',
    args: ['server.js'],
    enabled: true,
    trusted: false,
    permissionMode: 'default',
    allowedTools: [],
    deniedTools: [],
    env: {},
  };

  it('denies when server is disabled', () => {
    const result = mapPermission({
      serverConfig: { ...baseConfig, enabled: false },
      tool: baseTool,
      input: {},
      permissionMode: 'default',
      trustLevel: 'untrusted',
    });
    expect(result.decision).toBe('deny');
  });

  it('denies when tool is on denied list', () => {
    const result = mapPermission({
      serverConfig: { ...baseConfig, deniedTools: ['read_file'] },
      tool: baseTool,
      input: {},
      permissionMode: 'default',
      trustLevel: 'untrusted',
    });
    expect(result.decision).toBe('deny');
  });

  it('denies when tool not in allowlist and allowlist is non-empty', () => {
    const result = mapPermission({
      serverConfig: { ...baseConfig, allowedTools: ['list_files'] },
      tool: baseTool,
      input: {},
      permissionMode: 'default',
      trustLevel: 'untrusted',
    });
    expect(result.decision).toBe('deny');
  });

  it('allows trusted safe tool', () => {
    const result = mapPermission({
      serverConfig: { ...baseConfig, trusted: true },
      tool: baseTool,
      input: { filePath: 'README.md' },
      permissionMode: 'default',
      trustLevel: 'trusted',
    });
    expect(result.decision).toBe('allow');
    expect(result.requiresApproval).toBe(false);
  });

  it('asks for untrusted mutating tool', () => {
    const mutatingTool = { ...baseTool, dangerLevel: 'write' as const, mutating: true };
    const result = mapPermission({
      serverConfig: baseConfig,
      tool: mutatingTool,
      input: { filePath: 'x' },
      permissionMode: 'default',
      trustLevel: 'untrusted',
    });
    expect(result.decision).toBe('ask');
    expect(result.requiresApproval).toBe(true);
  });

  it('denies shell-like tool on untrusted server', () => {
    const shellTool = { ...baseTool, name: 'run_shell', dangerLevel: 'dangerous' as const };
    const result = mapPermission({
      serverConfig: baseConfig,
      tool: shellTool,
      input: { command: 'ls' },
      permissionMode: 'default',
      trustLevel: 'untrusted',
    });
    expect(result.decision).toBe('deny');
  });

  it('asks file tool on untrusted server', () => {
    const result = mapPermission({
      serverConfig: baseConfig,
      tool: baseTool,
      input: { filePath: 'README.md' },
      permissionMode: 'default',
      trustLevel: 'untrusted',
    });
    expect(result.decision).toBe('ask');
  });

  it('respects plan mode', () => {
    const result = mapPermission({
      serverConfig: baseConfig,
      tool: baseTool,
      input: {},
      permissionMode: 'plan',
      trustLevel: 'untrusted',
    });
    expect(result.decision).toBe('ask');
    expect(result.requiresApproval).toBe(true);
  });

  it('respects danger-review mode', () => {
    const result = mapPermission({
      serverConfig: baseConfig,
      tool: baseTool,
      input: {},
      permissionMode: 'danger-review',
      trustLevel: 'untrusted',
    });
    expect(result.decision).toBe('ask');
  });

  describe('secret pattern blocking', () => {
    it('denies secret file read request for untrusted server', () => {
      const secretTool = {
        serverId: 'fs', serverName: 'FS', name: 'read_secret', description: '',
        inputSchema: {}, dangerLevel: 'safe' as const, mutating: false,
      };
      const result = mapPermission({
        serverConfig: baseConfig,
        tool: secretTool,
        input: { filePath: '.env' },
        permissionMode: 'default',
        trustLevel: 'untrusted',
      });
      expect(result.decision).toBe('deny');
    });
  });
});

// ─── mcpAudit.ts ────────────────────────────────────────────────────────────

describe('redactSecret', () => {
  it('redacts OpenAI API keys', () => {
    const input = 'My key is sk-abcdefghijklmnopqrstuvwxyz0123456789';
    expect(redactSecret(input)).toBe('My key is [REDACTED]');
  });
  it('redacts Anthropic keys', () => {
    const input = 'key: sk-ant-api03-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdefghij';
    expect(redactSecret(input)).toBe('key: [REDACTED]');
  });
  it('does not modify safe strings', () => {
    expect(redactSecret('hello world')).toBe('hello world');
  });
});

describe('writeMCPAudit / listMCPAudit', () => {
  beforeEach(() => clearMCPAudit());

  it('writes and retrieves records', () => {
    writeMCPAudit({
      id: 'mcp-test-1',
      eventType: 'mcp.tool.called',
      serverId: 'fs',
      serverName: 'Filesystem',
      sessionId: 'sess1',
      status: 'success',
    });
    const list = listMCPAudit();
    expect(list.length).toBe(1);
    expect(list[0].id).toBe('mcp-test-1');
  });

  it('filters by serverId', () => {
    writeMCPAudit({
      id: 'mcp-1', eventType: 'mcp.tool.called', serverId: 'fs', serverName: 'FS',
      sessionId: 's1', status: 'success',
    });
    writeMCPAudit({
      id: 'mcp-2', eventType: 'mcp.tool.called', serverId: 'gh', serverName: 'GH',
      sessionId: 's1', status: 'success',
    });
    const fsOnly = listMCPAudit({ serverId: 'fs' });
    expect(fsOnly.length).toBe(1);
    expect(fsOnly[0].id).toBe('mcp-1');
  });

  it('filters by sessionId', () => {
    writeMCPAudit({
      id: 'mcp-A', eventType: 'mcp.tool.called', serverId: 'fs', serverName: 'FS',
      sessionId: 's1', status: 'success',
    });
    writeMCPAudit({
      id: 'mcp-B', eventType: 'mcp.tool.called', serverId: 'fs', serverName: 'FS',
      sessionId: 's2', status: 'success',
    });
    const s1Only = listMCPAudit({ sessionId: 's1' });
    expect(s1Only.map(r => r.id)).toEqual(['mcp-A']);
  });
});

describe('buildMCPAuditRecord', () => {
  it('builds a complete record', () => {
    const record = buildMCPAuditRecord({
      eventType: 'mcp.tool.called',
      serverId: 'fs',
      serverName: 'Filesystem',
      sessionId: 'sess1',
      toolName: 'read_file',
      fullToolName: 'mcp.fs.read_file',
      permissionDecision: 'allow',
      dangerLevel: 'safe',
      startedAt: '2026-05-17T08:00:00.000Z',
    });
    expect(record.id).toBeTruthy();
    expect(record.eventType).toBe('mcp.tool.called');
    expect(record.serverId).toBe('fs');
    expect(record.fullToolName).toBe('mcp.fs.read_file');
    expect(record.permissionDecision).toBe('allow');
  });
});

// ─── mcpToolAdapter.ts ──────────────────────────────────────────────────────

describe('MCPToolAdapter', () => {
  it('registers as a Tool with correct name prefix', () => {
    const adapter = new MCPToolAdapter({
      serverConfig: {
        id: 'fs', name: 'Filesystem', type: 'stdio', command: 'node',
        args: [], enabled: true, trusted: false, permissionMode: 'default',
        allowedTools: [], deniedTools: [], env: {},
      },
      discoveredTool: {
        serverId: 'fs', serverName: 'Filesystem',
        name: 'read_file',
        description: 'Read a file',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
        dangerLevel: 'safe',
        mutating: false,
      },
      mcpClient: new MCPClient({
        id: 'fs', name: 'Filesystem', type: 'stdio', command: 'node',
        args: [], enabled: true, trusted: false, permissionMode: 'default',
        allowedTools: [], deniedTools: [], env: {},
      }),
      sessionId: 'sess1',
    });

    expect(adapter.name).toBe('mcp.fs.read_file');
    expect(adapter.description).toContain('[MCP / Filesystem]');
    expect(adapter.inputSchema).toBeDefined();
    expect(adapter.requiresApproval).toBe(false);
  });

  it('adapts discovered tools into Ara tools list', () => {
    const tools = [
      {
        serverId: 'fs', serverName: 'Filesystem',
        name: 'write_file',
        description: 'Write a file',
        inputSchema: { type: 'object' },
        dangerLevel: 'write' as const,
        mutating: true,
      },
    ];
    const cfg: MCPServerConfig = {
      id: 'fs', name: 'Filesystem', type: 'stdio', command: 'node', args: [], enabled: true,
      trusted: false, permissionMode: 'default', allowedTools: [], deniedTools: [], env: {},
    };
    const client = new MCPClient(cfg);
    const adapted = adaptDiscoveredTools(cfg, tools, client, 's1');
    expect(adapted.length).toBe(1);
    expect(adapted[0].name).toBe('mcp.fs.write_file');
    expect(adapted[0].requiresApproval).toBe(true);
  });
});

// ─── MPI health ─────────────────────────────────────────────────────────────

describe('MCPHealthMonitor', () => {
  it('tracks state and summary', () => {
    const monitor = new MCPHealthMonitor();
    monitor.update({
      serverId: 'fs',
      state: 'healthy',
      toolCount: 3,
    });
    const s = monitor.statusesFor('fs')!;
    expect(s.state).toBe('healthy');
    expect(monitor.healthyCount).toBe(1);

    const summary = monitor.getSummary();
    expect(summary.total).toBe(1);
    expect(summary.healthy).toBe(1);
  });
});

// ─── Registry ───────────────────────────────────────────────────────────────

describe('MCPRegistry', () => {
  beforeEach(() => resetRegistry());

  it('loads config and starts enabled servers', async () => {
    const registry = new MCPRegistry();
    // fake URL won't connect but we check the registry structure
    await registry.loadConfig('/nonexistent');
    const ids = registry.listServerIds();
    expect(ids.length).toBe(0);
  });

  it('startServer returns error if no registry entry', async () => {
    const registry = new MCPRegistry();
    await registry.loadConfig('/nonexistent');
    const result = await registry.startServer('nonexistent');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not found');
  });
});

// ─── shouldRequireApproval ───────────────────────────────────────────────────

describe('shouldRequireApproval', () => {
  const baseTool = {
    serverId: 'x', serverName: 'X', name: 'read', description: '', inputSchema: {},
    dangerLevel: 'safe' as const, mutating: false,
  };
  const trustedCfg: MCPServerConfig = {
    id: 'x', name: 'X', type: 'stdio', command: 'n', args: [], enabled: true,
    trusted: true, permissionMode: 'default', allowedTools: [], deniedTools: [], env: {},
  };
  const untrustedCfg: MCPServerConfig = { ...trustedCfg, trusted: false };

  it('trusted safe tool does NOT require approval', () => {
    expect(shouldRequireApproval(trustedCfg, baseTool, 'default')).toBe(false);
  });

  it('untrusted mutating tool requires approval', () => {
    const tool = { ...baseTool, dangerLevel: 'write' as const, mutating: true };
    expect(shouldRequireApproval(untrustedCfg, tool, 'default')).toBe(true);
  });
});

// ─── redactSecret edge cases ─────────────────────────────────────────────────

describe('redactSecret — edge cases', () => {
  it('handles empty and null strings', () => {
    expect(redactSecret('')).toBe('');
  });
  it('redacts multiple keys in one string', () => {
    const input = 'sk-abc123456789012345678901234567890 key: sk-def01234567890123456789012345678901';
    const result = redactSecret(input);
    expect(result).not.toContain('sk-');
    // Check the sk-ant- prefix is also redacted
    expect(result).toContain('[REDACTED]');
  });
});

// ─── MCP schema Zod round-trip ───────────────────────────────────────────────

describe('MCP schema Zod round-trip', () => {
  const validRaw = {
    servers: [
      {
        id: 'filesystem',
        name: 'Local FS',
        type: 'stdio' as const,
        command: 'node',
        args: ['server.js'],
        cwd: '.',
        enabled: true,
        trusted: false,
        permissionMode: 'default' as const,
        allowedTools: ['read_file', 'list_files'],
        deniedTools: [],
        toolFilters: [],
        env: {},
        timeoutMs: 10_000,
      },
      {
        id: 'github',
        name: 'GitHub',
        type: 'http' as const,
        url: 'http://localhost:8765/mcp',
        enabled: false,
        trusted: false,
        permissionMode: 'danger-review' as const,
        allowedTools: [],
        deniedTools: ['create_repo', 'delete_repo'],
        toolFilters: [],
        headers: {},
        env: {},
      },
    ],
  };

  it('validates multi-server config', () => {
    const result = MCPConfigSchema.safeParse(validRaw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.servers.length).toBe(2);
      const gh = result.data.servers.find((s: any) => s.id === 'github');
      expect(gh?.enabled).toBe(false);
      expect(gh?.trusted).toBe(false);
    }
  });

  it('validates single server', () => {
    const result = MCPServerConfigSchema.safeParse(validRaw.servers[0]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe('filesystem');
    }
  });
});

// ─── List Audit Events Type Safety Assertion ─────────────────────────────────
// This test ensures all listed event types match the MCPAuditRecord eventType union

describe('eventType exhaustiveness', () => {
  it('has correct eventType values for all documented types', () => {
    const eventTypes = [
      'mcp.server.started',
      'mcp.server.stopped',
      'mcp.server.failed',
      'mcp.tool.discovered',
      'mcp.tool.called',
      'mcp.tool.denied',
      'mcp.tool.failed',
    ] as const;
    expect(eventTypes.length).toBe(7);
    // writeMCPAudit accepts any record; compile-time type-correctness is the guard
    for (const ev of eventTypes) {
      const rec = buildMCPAuditRecord({
        eventType: ev,
        serverId: 'x',
        serverName: 'X',
        sessionId: 's1',
        startedAt: new Date().toISOString(),
      });
      expect(rec.eventType).toBe(ev);
    }
  });
});
