import type { MCPServerConfig, MCPDiscoveredTool, MCPToolCall, MCPToolResult } from './types';

// ---------------------------------------------------------------------------
// Exception types (no secrets in messages)
// ---------------------------------------------------------------------------

export class MCPConnectionError extends Error {
  override name = 'MCPConnectionError';
  constructor(message: string) {
    super(message);
    this.message = message.replace(/sk-[a-zA-Z0-9]{32,}/g, '[REDACTED]')
                        .replace(/AIza[0-9A-Za-z-_]{35}/g, '[REDACTED]');
  }
}

export class MCPToolError extends Error {
  override name = 'MCPToolError';
  readonly toolName: string;
  readonly serverId: string;
  constructor(message: string, toolName: string, serverId: string) {
    super(message);
    this.toolName = toolName;
    this.serverId = serverId;
  }
}

// ---------------------------------------------------------------------------
// Minimal JSON-RPC message types
// ---------------------------------------------------------------------------
interface JSONRPCRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JSONRPCResponse {
  jsonrpc: '2.0';
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

function nextId(): () => number {
  let id = 0;
  return () => ++id;
}

const genId = nextId();

// ---------------------------------------------------------------------------
// MCP Client — minimal v0.1
// ---------------------------------------------------------------------------
export class MCPClient {
  private state: 'disconnected' | 'connecting' | 'ready' | 'error' = 'disconnected';
  private lastResponse: MCPToolResult | null = null;
  private lastError: string | undefined;
  private lastPingAt: string | undefined;
  private lastPingLatency: number | undefined;
  private readonly _httpBase: string;

  constructor(
    readonly serverConfig: MCPServerConfig,
    readonly logAudit?: (
      event: string,
      details: Record<string, unknown>
    ) => Promise<void>
  ) {
    this._httpBase = serverConfig.url?.replace(/\/$/, '') || '';
  }

  getServerId(): string {
    return this.serverConfig.id;
  }

  getState(): string {
    return this.state;
  }

  getLastError(): string | undefined {
    return this.lastError;
  }

  getLastResponse(): MCPToolResult | null {
    return this.lastResponse;
  }

  /** Initialize connection: list tools, verify server is reachable. */
  async initialize(): Promise<{ ok: boolean; tools: MCPDiscoveredTool[]; error?: string }> {
    if (this.serverConfig.type === 'http') {
      return this._httpInitialize();
    }
    return this._stdioInitialize();
  }

  /** Call a tool on this server. */
  async callTool(call: MCPToolCall): Promise<MCPToolResult> {
    if (this.serverConfig.type === 'http') {
      return this._httpCallTool(call);
    }
    return this._stdioCallTool(call);
  }

  /** Check health — protocol ping with fallback to process liveness. */
  async healthCheck(): Promise<{ healthy: boolean; latencyMs?: number; degraded?: boolean; error?: string }> {
    if (this.serverConfig.type === 'http') {
      return this._httpHealthCheck();
    }
    return this._stdioHealthCheck();
  }

  getLastPing(): { at?: string; latencyMs?: number } {
    return { at: this.lastPingAt, latencyMs: this.lastPingLatency };
  }

  /** Graceful shutdown. */
  async shutdown(): Promise<void> {
    if (this.state === 'disconnected') return;
    if (this.serverConfig.type === 'stdio') {
      try {
        this._stdioProc?.kill('SIGTERM');
      } catch {
        // ignore
      }
      this._stdioProc = undefined;
    }
    this.state = 'disconnected';
    if (this.logAudit) {
      await this.logAudit('mcp.server.stopped', { serverId: this.serverConfig.id });
    }
  }

  // ============================
  //  HTTP transport
  // ============================
  // Lazily allocated in initialize; re-use for all calls
  private _httpSession: AbortController | null = null;

  private async _httpRpc(
    method: string,
    params?: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const body: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: genId(),
      method,
      params,
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.serverConfig.headers,
    };

    const timeoutMs = this.serverConfig.timeoutMs || 15_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${this._httpBase}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new MCPConnectionError(
          `HTTP ${res.status} from ${this.serverConfig.id} — check server log for details`
        );
      }
      const data = (await res.json()) as JSONRPCResponse;
      if (data.error) {
        throw new MCPConnectionError(
          `MCP error [${data.error.code}]: ${data.error.message}`
        );
      }
      return (data.result as Record<string, unknown>) || {};
    } finally {
      clearTimeout(timer);
    }
  }

  private async _httpInitialize(): Promise<{ ok: boolean; tools: MCPDiscoveredTool[]; error?: string }> {
    try {
      const res = await this._httpRpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
      });
      if (res.error) {
        throw new MCPConnectionError(String(res.error));
      }

      // map tool/list call
      const toolsResult = await this._httpRpc('tools/list');
      if ((toolsResult as any).error) {
        throw new MCPConnectionError(String((toolsResult as any).error));
      }

      const tools = (toolsResult.tools as any[]) || [];
      const mapped = tools.map((t): MCPDiscoveredTool => ({
        serverId: this.serverConfig.id,
        serverName: this.serverConfig.name,
        name: t.name,
        description: t.description || '',
        inputSchema: (t.inputSchema as Record<string, unknown>) || {},
        dangerLevel: this._inferDangerLevel(t.name, false),
        mutating: this._inferMutating(t.name),
      }));

      this.state = 'ready';
      if (this.logAudit) {
        await this.logAudit('mcp.server.started', {
          serverId: this.serverConfig.id,
          toolsDiscovered: mapped.length,
        });
      }
      return { ok: true, tools: mapped };
    } catch (e: any) {
      this.state = 'error';
      this.lastError = e.message;
      if (this.logAudit) {
        await this.logAudit('mcp.server.failed', {
          serverId: this.serverConfig.id,
          error: e.message.replace(/sk-[a-zA-Z0-9]{32,}/g, '[REDACTED]'),
        });
      }
      return { ok: false, tools: [], error: e.message };
    }
  }

  private async _httpCallTool(call: MCPToolCall): Promise<MCPToolResult> {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    try {
      const res = await this._httpRpc('tools/call', {
        name: call.toolName,
        arguments: call.input,
      });
      const content = typeof res.content === 'string'
        ? res.content
        : JSON.stringify(res.content);
      const finishedAt = new Date().toISOString();
      const result: MCPToolResult = {
        ok: true,
        content,
        outputSummary: content.slice(0, 500),
        rawResponse: res,
        startedAt,
        finishedAt,
        durationMs: Date.now() - t0,
      };
      this.lastResponse = result;
      if (this.logAudit) {
        await this.logAudit('mcp.tool.called', {
          serverId: call.serverId,
          toolName: call.toolName,
          fullToolName: `mcp.${call.serverId}.${call.toolName}`,
          durationMs: result.durationMs,
        });
      }
      return result;
    } catch (e: any) {
      const finishedAt = new Date().toISOString();
      const errorMsg = this._redact(String(e.message));
      const result: MCPToolResult = {
        ok: false,
        content: '',
        outputSummary: `[MCP tool error: ${errorMsg}]`,
        error: errorMsg,
        startedAt,
        finishedAt,
        durationMs: Date.now() - t0,
      };
      if (this.logAudit) {
        await this.logAudit('mcp.tool.failed', {
          serverId: call.serverId,
          toolName: call.toolName,
          error: errorMsg,
        });
      }
      return result;
    }
  }

  private async _httpHealthCheck(): Promise<{ healthy: boolean; latencyMs?: number; degraded?: boolean; error?: string }> {
    const t0 = Date.now();
    try {
      await this._httpRpc('ping', {});
      this.lastPingAt = new Date().toISOString();
      this.lastPingLatency = Date.now() - t0;
      return { healthy: true, latencyMs: Date.now() - t0 };
    } catch (e: any) {
      this.lastError = e.message;
      return { healthy: false, latencyMs: Date.now() - t0, degraded: true, error: e.message };
    }
  }

  private async _stdioHealthCheck(): Promise<{ healthy: boolean; latencyMs?: number; degraded?: boolean; error?: string }> {
    const t0 = Date.now();

    // 1. Check process liveness first
    if (!this._stdioProc || this._stdioProc.killed) {
      this.lastPingAt = undefined;
      return { healthy: false, degraded: false, error: 'Process not running' };
    }

    // 2. Try protocol-level ping
    try {
      const pingMsg = JSON.stringify({
        jsonrpc: '2.0',
        id: genId(),
        method: 'ping',
        params: {},
      });
      await Bun.write(this._stdioProc.stdin!, pingMsg + '\n');

      const reader = this._stdioProc.stdout.getReader();
      await Promise.race([
        this._readJsonLine(reader),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error('ping timeout')), 2000)
        ),
      ]);

      this.lastPingAt = new Date().toISOString();
      this.lastPingLatency = Date.now() - t0;
      return { healthy: true, latencyMs: Date.now() - t0 };
    } catch (e: any) {
      // Ping failed — degraded (process is alive but not responding)
      this.lastPingAt = undefined;
      this.lastPingLatency = Date.now() - t0;
      return { healthy: false, latencyMs: Date.now() - t0, degraded: true, error: e.message };
    }
  }

  // ============================
  //  stdio transport
  // ============================
  private _stdioProc: ReturnType<typeof Bun.spawn> | undefined;

  private async _stdioInitialize(): Promise<{ ok: boolean; tools: MCPDiscoveredTool[]; error?: string }> {
    if (this.state === 'starting') {
      return { ok: false, tools: [], error: 'Already starting' };
    }
    this.state = 'starting';
    this.lastError = undefined;

    const cmd = this.serverConfig.command || 'node';
    const args = this.serverConfig.args || [];
    const cwd = this.serverConfig.cwd || '.';
    const timeoutMs = this.serverConfig.timeoutMs || 15_000;

    try {
      const proc = Bun.spawn({
        cmd: [cmd, ...(args as string[])],
        cwd,
        env: this._buildStrictEnv(),
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });

      this._stdioProc = proc;

      // stdio MCP is a line-delimited JSON transport on stdin/stdout
      // We send initialization sequence and await a response
      const initMsg = JSON.stringify({
        jsonrpc: '2.0',
        id: genId(),
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
        },
      });

      // In a real implementation we'd set up a proper bidirectional pipe.
      // For v0.1, if we can write to stdin we treat the server as healthy,
      // then discover tools by sending a tools/list request.
      try {
        await Bun.write(proc.stdin, initMsg + '\n');
        const reader = proc.stdout.getReader();
        const { value, done } = await Promise.race([
          this._readJsonLine(reader),
          new Promise<{ done: true }>((_, rej) =>
            setTimeout(() => rej(new Error('stdio init timeout')), timeoutMs)
          ),
        ]);
        if (done) throw new Error('stdio stream ended during init');

        this.state = 'ready';
        if (this.logAudit) {
          await this.logAudit('mcp.server.started', { serverId: this.serverConfig.id });
        }
        return { ok: true, tools: [] };
      } catch (stdioErr: any) {
        throw new MCPConnectionError(`stdio connection failed: ${this._redact(stdioErr.message)}`);
      }
    } catch (e: any) {
      this.state = 'error';
      this.lastError = this._redact(e.message);
      if (this.logAudit) {
        await this.logAudit('mcp.server.failed', {
          serverId: this.serverConfig.id,
          error: this.lastError,
        });
      }
      return { ok: false, tools: [], error: this.lastError };
    }
  }

  private async _stdioCallTool(call: MCPToolCall): Promise<MCPToolResult> {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    if (!this._stdioProc || this.state !== 'ready') {
      const result: MCPToolResult = {
        ok: false,
        content: '',
        outputSummary: '[stdio server not connected]',
        error: `Server ${call.serverId} is not connected`,
        startedAt,
      };
      return result;
    }

    const callMsg = JSON.stringify({
      jsonrpc: '2.0',
      id: genId(),
      method: 'tools/call',
      params: { name: call.toolName, arguments: call.input },
    });

    try {
      await Bun.write(this._stdioProc.stdin!, callMsg + '\n');
      const reader = this._stdioProc.stdout.getReader();
      const { value, done } = await Promise.race([
        this._readJsonLine(reader),
        new Promise<{ done: boolean }>((_, rej) =>
          setTimeout(() => rej(new Error('stdio tool call timeout')), this.serverConfig.timeoutMs)
        ),
      ]);

      const text = value ? new TextDecoder().decode(value) : '';
      const data = value ? JSON.parse(text) : {};
      const result: MCPToolResult = {
        ok: !data.error,
        content: typeof data.result === 'string' ? data.result : JSON.stringify(data.result),
        outputSummary:
          typeof data.result === 'string' ? data.result.slice(0, 500) : JSON.stringify(data.result).slice(0, 500),
        rawResponse: data.result ? {} : undefined,
        error: data.error ? String(data.error) : undefined,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - t0,
      };

      if (this.logAudit) {
        await this.logAudit('mcp.tool.called', {
          serverId: call.serverId,
          toolName: call.toolName,
          durationMs: result.durationMs,
        });
      }
      return result;
    } catch (e: any) {
      if (this.logAudit) {
        await this.logAudit('mcp.tool.failed', {
          serverId: call.serverId,
          toolName: call.toolName,
          error: this._redact(e.message),
        });
      }
      return {
        ok: false,
        content: '',
        outputSummary: `[MCP tool error: ${this._redact(e.message)}]`,
        error: this._redact(e.message),
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - t0,
      };
    }
  }

  // --- helpers ---
  private async _readJsonLine(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<{ value?: Uint8Array; done: boolean }> {
    // Read chunks until we assemble a full JSON line (LF-terminated)
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) return { done: true };
      buf += new TextDecoder().decode(value);
      const lf = buf.indexOf('\n');
      if (lf >= 0) {
        const line = buf.slice(0, lf).trim();
        buf = buf.slice(lf + 1);
        if (line) {
          // return the frame body; the caller will parse it
          return { value: new TextEncoder().encode(line), done: false };
        }
      }
    }
  }

  private _redact(str: string): string {
    return str
      .replace(/sk-[a-zA-Z0-9]{32,}/g, '[REDACTED]')
      .replace(/sk-ant-[a-zA-Z0-9_-]{20,}/g, '[REDACTED]')
      .replace(/AIza[0-9A-Za-z-_]{35}/g, '[REDACTED]')
      .replace(/ghp_[a-zA-Z0-9]{36,}/g, '[REDACTED]')
      .replace(/glpat-[a-zA-Z0-9\-_]{20,}/g, '[REDACTED]');
  }

  private _buildStrictEnv(): Record<string, string> {
    const explicit = this.serverConfig.env || {};
    // Only pass explicitly listed env vars from the server config — no full process.env passthrough
    return { ...explicit };
  }

  private _inferDangerLevel(_name: string, mutating: boolean): 'safe' | 'write' | 'network' | 'dangerous' {
    if (mutating) return 'write';
    return 'safe';
  }

  private _inferMutating(toolName: string): boolean {
    const mutationKeywords = [
      'write', 'edit', 'delete', 'remove', 'create', 'update', 'patch',
      'apply', 'commit', 'push', 'merge', 'move', 'rename', 'upload',
      'run', 'exec', 'shell', 'command', 'install', 'build',
    ];
    const lower = toolName.toLowerCase();
    return mutationKeywords.some(k => lower.includes(k));
  }
}
