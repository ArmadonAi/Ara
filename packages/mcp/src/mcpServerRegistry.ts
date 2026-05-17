import type { MCPServerConfig, MCPDiscoveredTool, MCPServerState } from './types';
import { loadMCPConfig, listEnabledServers } from './mcpConfig';
import { MCPClient, MCPConnectionError } from './mcpClient';

// --------------- singleton registry ----------------

interface ServerEntry {
  config: MCPServerConfig;
  client: MCPClient;
  state: MCPServerState;
  lastError?: string;
  lastCheckedAt: string;
  tools: MCPDiscoveredTool[];
  uptimeStart?: number;
}

export class MCPRegistry {
  #servers: Map<string, ServerEntry> = new Map();
  #config: ReturnType<typeof loadMCPConfig> | null = null;
  #logAudit?: (event: string, details: Record<string, unknown>) => Promise<void>;

  constructor(logAudit?: (event: string, details: Record<string, unknown>) => Promise<void>) {
    this.#logAudit = logAudit;
  }

  /** Load .ara/mcp.json and register entries for enabled servers. */
  async loadConfig(cwd: string = process.cwd()): Promise<{ names: string[]; skipped: number }> {
    this.#config = await loadMCPConfig(cwd);
    const enabled = listEnabledServers(this.#config);
    const skipped = this.#config.servers.length - enabled.length;
    const names: string[] = [];

    for (const cfg of enabled) {
      this.#registerEntry(cfg);
      names.push(cfg.id);
    }
    return { names, skipped };
  }

  /** Return full config as loaded. */
  getConfig(): { servers: MCPServerConfig[] } {
    return this.#config || { servers: [] };
  }

  /** List all server IDs from config (enabled + disabled). */
  listServerIds(): string[] {
    return (this.#config?.servers || []).map(s => s.id);
  }

  /** List enabled server entries. */
  listEnabled(): ServerEntry[] {
    const ids = (this.#config ? listEnabledServers(this.#config) : []).map(s => s.id);
    return ids
      .map(id => this.#servers.get(id))
      .filter((e): e is ServerEntry => !!e && e.config.enabled);
  }

  /** Get a specific server entry by id. */
  getServer(id: string): ServerEntry | undefined {
    return this.#servers.get(id);
  }

  /**
   * Start a server — only if enabled in config.
   * Disabled servers cannot be started.
   * Untrusted servers may be started (caller checks trust separately).
   */
  async startServer(id: string): Promise<{ ok: boolean; tools: MCPDiscoveredTool[]; error?: string }> {
    const entry = this.#servers.get(id);
    if (!entry) {
      return { ok: false, tools: [], error: `Server "${id}" not found in config` };
    }
    if (!entry.config.enabled) {
      return { ok: false, tools: [], error: `Server "${id}" is disabled` };
    }
    if (entry.state === 'starting') {
      return { ok: false, tools: [], error: `Server "${id}" is already starting` };
    }
    if (entry.state === 'healthy' || entry.state === 'ready') {
      return { ok: true, tools: entry.tools };
    }

    entry.state = 'starting';
    const client = entry.client;

    try {
      const result = await client.initialize();
      if (result.ok) {
        entry.state = 'healthy';
        entry.tools = result.tools;
        entry.uptimeStart = Date.now();
        entry.lastCheckedAt = new Date().toISOString();
        return { ok: true, tools: result.tools };
      } else {
        entry.state = 'error';
        entry.lastError = result.error;
        return { ok: false, tools: [], error: result.error };
      }
    } catch (e: any) {
      entry.state = 'error';
      entry.lastError = e.message;
      return { ok: false, tools: [], error: e.message };
    }
  }

  /** Stop a server and release its client. */
  async stopServer(id: string): Promise<{ ok: boolean; error?: string }> {
    const entry = this.#servers.get(id);
    if (!entry) return { ok: false, error: `Server "${id}" not found` };

    try {
      await entry.client.shutdown();
      entry.state = 'stopped';
      entry.uptimeStart = undefined;
      entry.lastCheckedAt = new Date().toISOString();
      return { ok: true };
    } catch (e: any) {
      entry.state = 'error';
      entry.lastError = e.message;
      return { ok: false, error: e.message };
    }
  }

  /** Restart: stop → start. */
  async restartServer(id: string): Promise<{ ok: boolean; tools: MCPDiscoveredTool[]; error?: string }> {
    await this.stopServer(id);
    return this.startServer(id);
  }

  /**
   * Health check one or all servers using protocol ping.
   * Returns enriched health states: healthy, degraded, unhealthy, stopped, disabled.
   */
  async healthCheck(id?: string): Promise<import('./types').MCPHealthStatus[]> {
    const entries = id
      ? [this.#servers.get(id)].filter((e): e is ServerEntry => !!e)
      : Array.from(this.#servers.values());

    const results: import('./types').MCPHealthStatus[] = [];
    for (const entry of entries) {
      const uptimeMs = entry.uptimeStart ? Date.now() - entry.uptimeStart : undefined;

      // Resolve health state
      let state: import('./types').MCPServerState = entry.state;
      let lastError = entry.lastError;
      let lastPingAt: string | undefined;
      let lastPingLatency: number | undefined;

      if (!entry.config.enabled) {
        state = 'disabled';
      } else if (entry.state === 'stopped') {
        state = 'stopped';
      } else if (entry.state === 'error') {
        state = 'unhealthy';
      } else if (entry.state === 'healthy' || entry.state === 'ready') {
        // Active ping to determine current health
        try {
          const pingResult = await entry.client.healthCheck();
          lastPingAt = new Date().toISOString();
          if (pingResult.healthy) {
            state = 'healthy';
            entry.state = 'healthy';
          } else if (pingResult.degraded) {
            state = 'degraded' as any;
          } else {
            state = 'unhealthy';
            entry.state = 'error';
          }
        } catch {
          state = 'unhealthy';
          entry.state = 'error';
        }
      }

      const pingInfo = entry.client && typeof entry.client.getLastPing === 'function'
        ? entry.client.getLastPing()
        : {};
      lastPingAt = lastPingAt || pingInfo.at;
      lastPingLatency = lastPingLatency || pingInfo.latencyMs;

      results.push({
        serverId: entry.config.id,
        state,
        lastError,
        lastCheckedAt: new Date().toISOString(),
        uptimeMs,
        toolCount: entry.tools.length,
        lastPingAt,
        lastPingLatency,
      } as import('./types').MCPHealthStatus);
    }
    return results;
  }

  /** Discover tools from a specific server. */
  async discoverTools(id: string): Promise<{ ok: boolean; tools: MCPDiscoveredTool[]; error?: string }> {
    return this.startServer(id);
  }

  /**
   * Refresh tools from a running server without restarting.
   * Disabled/stopped servers are not started — returns error.
   */
  async refreshTools(id: string): Promise<{ ok: boolean; tools: MCPDiscoveredTool[]; error?: string; removed?: string[] }> {
    const entry = this.#servers.get(id);
    if (!entry) {
      return { ok: false, tools: [], error: `Server "${id}" not found` };
    }
    if (!entry.config.enabled) {
      return { ok: false, tools: [], error: `Server "${id}" is disabled — enable it first` };
    }
    if (entry.state !== 'healthy' && entry.state !== 'ready') {
      return { ok: false, tools: [], error: `Server "${id}" is not running (state: ${entry.state})` };
    }

    try {
      // Remember old tool names to detect removals
      const oldToolNames = new Set(entry.tools.map(t => t.name));

      // Re-initialize client to get fresh tool list
      const client = entry.client;
      const result = await client.initialize();
      if (!result.ok) {
        return { ok: false, tools: [], error: result.error };
      }

      // Detect removed tools
      const newToolNames = new Set(result.tools.map(t => t.name));
      const removed = entry.tools
        .filter(t => !newToolNames.has(t.name))
        .map(t => t.name);

      // Update entry
      entry.tools = result.tools;
      entry.state = 'healthy';
      entry.lastCheckedAt = new Date().toISOString();

      return { ok: true, tools: result.tools, removed };
    } catch (e: any) {
      entry.state = 'error';
      entry.lastError = e.message;
      return { ok: false, tools: [], error: e.message };
    }
  }

  /**
   * Reconnect a failed server: stop → re-register → start.
   * Returns error for disabled or healthy servers (use refresh for healthy).
   */
  async reconnectServer(id: string): Promise<{ ok: boolean; tools: MCPDiscoveredTool[]; error?: string }> {
    const entry = this.#servers.get(id);
    if (!entry) {
      return { ok: false, tools: [], error: `Server "${id}" not found` };
    }
    if (!entry.config.enabled) {
      return { ok: false, tools: [], error: `Server "${id}" is disabled — enable it first` };
    }
    if (entry.state === 'healthy' || entry.state === 'ready') {
      return { ok: false, tools: [], error: `Server "${id}" is already healthy — use refresh instead` };
    }

    // Stop, re-register with fresh client, start
    try {
      await entry.client.shutdown().catch(() => {});
    } catch {
      // ignore shutdown errors
    }

    // Re-register entry with new client
    this.#registerEntry(entry.config);

    // Start
    return this.startServer(id);
  }

  /**
   * Refresh tools from all running (healthy) servers.
   * Disabled and stopped servers are skipped.
   */
  async refreshAllTools(): Promise<{
    results: { serverId: string; ok: boolean; toolCount: number; removed?: string[]; error?: string }[];
  }> {
    const results: { serverId: string; ok: boolean; toolCount: number; removed?: string[]; error?: string }[] = [];
    for (const serverId of this.listServerIds()) {
      const entry = this.#servers.get(serverId);
      if (!entry || !entry.config.enabled || (entry.state !== 'healthy' && entry.state !== 'ready')) {
        continue; // skip disabled/stopped servers
      }
      const r = await this.refreshTools(serverId);
      results.push({
        serverId,
        ok: r.ok,
        toolCount: r.tools.length,
        removed: r.removed,
        error: r.error,
      });
    }
    return { results };
  }

  // --------------- private ---------------

  #registerEntry(cfg: MCPServerConfig): void {
    const client = new MCPClient(cfg, this.#logAudit);
    this.#servers.set(cfg.id, {
      config: cfg,
      client,
      state: 'stopped',
      tools: [],
      lastCheckedAt: new Date().toISOString(),
    });
  }
}

// singleton exported for the app
let _instance: MCPRegistry | null = null;

export function getRegistry(logAudit?: (event: string, details: Record<string, unknown>) => Promise<void>): MCPRegistry {
  if (!_instance) {
    _instance = new MCPRegistry(logAudit);
  }
  return _instance;
}

export function resetRegistry(): void {
  _instance = null;
}
