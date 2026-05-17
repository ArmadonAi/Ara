import type { MCPConfig, MCPServerConfig } from './types';
import { MCPConfigSchema, MCPServerConfigSchema } from './types';

// ============================
// Validation helpers
// ============================

export function validateMCPConfig(
  raw: unknown
): { ok: boolean; data?: MCPConfig; error?: string } {
  const result = MCPConfigSchema.safeParse(raw);
  if (!result.success) {
    return { ok: false, error: result.error.message };
  }
  return { ok: true, data: result.data };
}

export function validateServerConfig(
  raw: unknown
): { ok: boolean; data?: MCPServerConfig; error?: string } {
  const result = MCPServerConfigSchema.safeParse(raw);
  if (!result.success) {
    return { ok: false, error: result.error.message };
  }
  return { ok: true, data: result.data };
}

export function sanitizeServerConfig(cfg: MCPServerConfig): MCPServerConfig {
  return {
    ...cfg,
    env: {},
  };
}

export { MCPConfigSchema, MCPServerConfigSchema, MCPServerTypeSchema, MCPServerStateSchema, MCPToolFilterSchema } from './types';
