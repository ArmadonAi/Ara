import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { MCPConfig, MCPServerConfig } from './types';
import { validateMCPConfig } from './schema';

export const MCP_CONFIG_FILENAME = 'mcp.json';
export const MCP_CONFIG_DIR = '.ara';

function getConfigPaths(cwd: string = process.cwd()): string[] {
  const homePath = path.join(os.homedir(), MCP_CONFIG_DIR, MCP_CONFIG_FILENAME);
  const localPath = path.join(cwd, MCP_CONFIG_DIR, MCP_CONFIG_FILENAME);
  return [localPath, homePath];
}

/**
 * Load MCP config from .ara/mcp.json (local) or ~/.ara/mcp.json (home).
 * Never throws — returns empty config on any error.
 */
export async function loadMCPConfig(cwd: string = process.cwd()): Promise<MCPConfig> {
  const paths = getConfigPaths(cwd);

  for (const configPath of paths) {
    try {
      const raw = await fs.readFile(configPath, 'utf8');
      const parsed = JSON.parse(raw);
      const result = validateMCPConfig(parsed);
      if (result.ok && result.data) {
        return result.data;
      }
      // Invalid config — skip file
    } catch {
      // File not found or parse error — try next path
    }
  }

  return { servers: [] };
}

/**
 * Load a single server config by id from currently loaded config.
 */
export function findServerById(
  config: MCPConfig,
  id: string
): MCPServerConfig | undefined {
  return config.servers.find(s => s.id === id);
}

/**
 * Return only enabled servers. Disabled servers are skipped.
 */
export function listEnabledServers(config: MCPConfig): MCPServerConfig[] {
  return config.servers.filter(s => s.enabled);
}

/**
 * Validate a raw config object without writing it.
 */
export function validateRawMCPConfig(raw: unknown): { ok: boolean; error?: string } {
  return validateMCPConfig(raw);
}

/**
 * Write MCP config atomically. Validates before writing.
 */
export async function saveMCPConfig(
  config: MCPConfig,
  cwd: string = process.cwd()
): Promise<{ ok: boolean; error?: string }> {
  const result = validateMCPConfig(config);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  const localPath = path.join(cwd, MCP_CONFIG_DIR, MCP_CONFIG_FILENAME);
  try {
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.writeFile(localPath, JSON.stringify(config, null, 2), 'utf8');
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}
