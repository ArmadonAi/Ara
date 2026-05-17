import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { GitHubConfig } from './types';

const CONFIG_FILENAME = 'github.json';
const CONFIG_DIR = '.ara';

function getConfigPaths(cwd: string): string[] {
  return [
    path.join(cwd, CONFIG_DIR, CONFIG_FILENAME),
    path.join(os.homedir(), CONFIG_DIR, CONFIG_FILENAME),
  ];
}

/**
 * Load GitHub config from .ara/github.json (local) or ~/.ara/github.json (home).
 * Never throws — returns default config on any error.
 */
export async function loadGitHubConfig(cwd: string = process.cwd()): Promise<GitHubConfig> {
  const paths = getConfigPaths(cwd);
  for (const configPath of paths) {
    try {
      const raw = await fs.readFile(configPath, 'utf8');
      const parsed = JSON.parse(raw);
      const { validateGitHubConfig } = await import('./schema');
      const result = validateGitHubConfig(parsed);
      if (result.ok && result.data) {
        return result.data as GitHubConfig;
      }
    } catch {
      // File not found or error — try next path
    }
  }
  return {
    enabled: true,
    apiBaseUrl: 'https://api.github.com',
    tokenEnv: 'GITHUB_TOKEN',
    permissionMode: 'default',
    allowedRepos: [],
    readOnly: false,
  };
}

/**
 * Get the GitHub token from the configured env var.
 * Never reads .env files directly.
 */
export function getGitHubToken(config: GitHubConfig): string | null {
  try {
    return process.env[config.tokenEnv] || null;
  } catch {
    return null;
  }
}

/**
 * Check if a repo (owner/name) is in the allowed repos list.
 */
export function isRepoAllowed(config: GitHubConfig, owner: string, repo: string): boolean {
  if (!config.allowedRepos || config.allowedRepos.length === 0) return true;
  const full = `${owner}/${repo}`;
  return config.allowedRepos.some(r => r.toLowerCase() === full.toLowerCase());
}
