export class MCPHealthMonitor {
  private readonly statuses: Map<string, ReturnType<typeof this._buildStatus>> = new Map();

  update(stat: {
    serverId: string;
    state: import('./types').MCPServerState;
    lastError?: string;
    toolCount: number;
    uptimeMs?: number;
  }) {
    const s = this._buildStatus(stat);
    this.statuses.set(stat.serverId, s);
    return s;
  }

  /** Return the latest status for one or all servers. */
  statusesFor(serverId?: string) {
    if (serverId) {
      return this.statuses.get(serverId) || null;
    }
    return Array.from(this.statuses.values());
  }

  /** Healthy count across all tracked servers. */
  get healthyCount(): number {
    return Array.from(this.statuses.values()).filter(s => s.state === 'healthy').length;
  }

  /** Healthy check → overall summary object. */
  getSummary() {
    const all = this.statusesFor();
    return {
      total: all.length,
      healthy: this.healthyCount,
      unhealthy: all.filter(s => s.state === 'error' || s.state === 'unhealthy').length,
      disabled: all.filter(s => s.state === 'disabled').length,
      servers: all,
    };
  }

  private _buildStatus(stat: {
    serverId: string;
    state: import('./types').MCPServerState;
    lastError?: string;
    toolCount: number;
    uptimeMs?: number;
  }) {
    return {
      serverId: stat.serverId,
      state: stat.state,
      lastError: stat.lastError,
      lastCheckedAt: new Date().toISOString(),
      uptimeMs: stat.uptimeMs,
      toolCount: stat.toolCount,
    } as import('./types').MCPHealthStatus;
  }
}
