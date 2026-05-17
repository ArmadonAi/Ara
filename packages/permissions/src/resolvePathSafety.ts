import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

export interface PathSafetyResult {
  safe: boolean;
  reason?: string;
  resolvedPath?: string;
}

export function resolvePathSafety(filePath: string, cwd: string): PathSafetyResult {
  if (!filePath) {
    return { safe: true, resolvedPath: '' };
  }

  // 1. Block null bytes
  if (filePath.includes('\0')) {
    return { safe: false, reason: 'Path contains null bytes' };
  }

  // Normalize separators
  let normalizedPath = filePath.replace(/\\/g, '/');

  // 2. Block `../` escape sequences directly
  if (normalizedPath.includes('../') || normalizedPath.includes('..\\')) {
    return { safe: false, reason: 'Directory traversal sequence (../) detected' };
  }

  // 3. Resolve home directory `~`
  const homeDir = os.homedir().replace(/\\/g, '/');
  if (normalizedPath.startsWith('~/')) {
    normalizedPath = normalizedPath.replace(/^~\//, homeDir + '/');
  } else if (normalizedPath === '~') {
    normalizedPath = homeDir;
  }

  // 4. Resolve absolute paths vs relative paths
  let resolvedPath = '';
  if (path.isAbsolute(normalizedPath) || /^[a-zA-Z]:\//.test(normalizedPath)) {
    resolvedPath = path.resolve(normalizedPath);
  } else {
    resolvedPath = path.resolve(cwd, normalizedPath);
  }
  resolvedPath = resolvedPath.replace(/\\/g, '/');

  // 5. Block home directory secret paths explicitly
  const lowerResolved = resolvedPath.toLowerCase();
  const lowerHome = homeDir.toLowerCase();
  const secretPatterns = [
    `${lowerHome}/.ssh`,
    `${lowerHome}/.aws`,
    `${lowerHome}/.config/gcloud`,
    `${lowerHome}/.env`,
  ];
  for (const pattern of secretPatterns) {
    if (lowerResolved === pattern || lowerResolved.startsWith(pattern + '/')) {
      return { safe: false, reason: `Access to home directory secrets (${pattern}) is denied`, resolvedPath };
    }
  }

  // 6. Check if path is outside workspace (cwd)
  const normalizedCwd = path.resolve(cwd).replace(/\\/g, '/').toLowerCase();
  const isInside = lowerResolved === normalizedCwd || lowerResolved.startsWith(normalizedCwd.endsWith('/') ? normalizedCwd : normalizedCwd + '/');

  if (!isInside) {
    return { safe: false, reason: 'Path resolves outside the current working workspace directory', resolvedPath };
  }

  // 7. Check symlinks if the target file/dir exists
  try {
    if (fs.existsSync(resolvedPath)) {
      const realPath = fs.realpathSync(resolvedPath).replace(/\\/g, '/');
      const lowerReal = realPath.toLowerCase();
      const isRealInside = lowerReal === normalizedCwd || lowerReal.startsWith(normalizedCwd.endsWith('/') ? normalizedCwd : normalizedCwd + '/');
      
      if (!isRealInside) {
        return { safe: false, reason: 'Symlink target resolves outside the current working workspace directory', resolvedPath };
      }
      for (const pattern of secretPatterns) {
        if (lowerReal === pattern || lowerReal.startsWith(pattern + '/')) {
          return { safe: false, reason: `Symlink target accesses home directory secrets (${pattern})`, resolvedPath };
        }
      }
    }
  } catch (e) {
    // If it doesn't exist yet, we still check the resolvedPath itself
  }

  return { safe: true, resolvedPath };
}
