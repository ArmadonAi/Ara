import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Normalize a file path for lock key comparison.
 * Resolves relative paths, normalizes separators, and lowercases on Windows.
 */
export function normalizePath(p: string): string {
  const resolved = path.resolve(p);
  // On Windows, normalize drive letter case and separators
  if (process.platform === 'win32') {
    return resolved.replace(/\\/g, '/').toLowerCase();
  }
  return resolved;
}

/**
 * Resolve a path's real (symlink-resolved) path.
 * Falls back to normalized path if realpath fails (e.g. file doesn't exist yet).
 */
export function resolveRealPath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    // File may not exist yet — try parent directory
    const parent = path.dirname(p);
    try {
      const realParent = fs.realpathSync.native(parent);
      return normalizePath(path.join(realParent, path.basename(p)));
    } catch {
      return normalizePath(p);
    }
  }
}

/**
 * Check if a path is within the workspace directory.
 */
export function isPathInWorkspace(p: string, workspaceId: string): boolean {
  const normalized = normalizePath(p);
  const ws = normalizePath(workspaceId);
  return normalized.startsWith(ws);
}

/**
 * Check if two paths conflict (one is within the other's directory tree).
 */
export function pathsConflict(p1: string, p2: string): boolean {
  const n1 = normalizePath(p1);
  const n2 = normalizePath(p2);
  return n1 === n2 || n1.startsWith(n2 + '/') || n2.startsWith(n1 + '/');
}
