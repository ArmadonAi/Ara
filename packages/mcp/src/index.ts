// @ara/mcp — MCP / External Tools package
// Provides server registry, client transports, tool adapters, permission mapping,
// audit logging, health checking, and config loading for the Ara MCP integration.

export * from './types';
export * from './schema';
export * from './mcpConfig';
export { MCPClient, MCPConnectionError, MCPToolError } from './mcpClient';
export { getRegistry, resetRegistry, MCPRegistry } from './mcpServerRegistry';
export type { ServerEntry } from './mcpServerRegistry';
export { MCPToolAdapter, adaptDiscoveredTools } from './mcpToolAdapter';
export { mapPermission, shouldRequireApproval } from './mcpPermissionMapper';
export {
  writeMCPAudit, writeMCPAuditBatch, listMCPAudit, buildMCPAuditRecord, redactSecret,
  clearMCPAudit, clearAuditFile, initAuditStore, setAuditEnabled, getAuditPath,
  reloadAuditFromDisk, getAuditCount,
} from './mcpAudit';
export { MCPHealthMonitor } from './mcpHealth';
export { discoverHTTPServers, getKnownServers, installMCPServer, mergeServerConfig } from './mcpDiscovery';
