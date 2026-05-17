import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { resolvePathSafety } from '@ara/permissions';
import type { CheckpointFileSnapshot } from './types';

// Helper to determine if a file name or path is a private key or secret
export function isSecretFile(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  const ext = path.extname(filePath).toLowerCase();
  
  if (base === '.env' || base.startsWith('.env.')) {
    return true;
  }
  if (ext === '.pem' || ext === '.key') {
    return true;
  }
  if (base.includes('id_rsa') || base.includes('id_dsa') || base.includes('id_ecdsa') || base.includes('id_ed25519')) {
    return true;
  }
  return false;
}

// Helper to check if buffer has binary signature (contains null bytes)
export function isBinaryBuffer(buf: Buffer): boolean {
  const checkLen = Math.min(buf.length, 8000);
  for (let i = 0; i < checkLen; i++) {
    if (buf[i] === 0) {
      return true;
    }
  }
  return false;
}

// Check common binary file extensions
export function isBinaryExtension(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  const binaryExtensions = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico',
    '.zip', '.tar', '.gz', '.rar', '.7z',
    '.pdf', '.epub',
    '.exe', '.dll', '.so', '.dylib', '.wasm',
    '.mp3', '.mp4', '.wav', '.mov', '.avi',
    '.db', '.sqlite', '.sqlite3', '.bin', '.dat'
  ]);
  return binaryExtensions.has(ext);
}

// Take a single file snapshot
export async function takeFileSnapshot(
  relPath: string,
  cwd: string
): Promise<CheckpointFileSnapshot> {
  const normalizedPath = relPath.replace(/\\/g, '/');
  
  // 1. Evaluate Permission Engine path safety
  const safety = resolvePathSafety(normalizedPath, cwd);
  if (!safety.safe || !safety.resolvedPath) {
    return {
      path: normalizedPath,
      absolutePath: safety.resolvedPath || path.resolve(cwd, normalizedPath).replace(/\\/g, '/'),
      existsBefore: false,
      sizeBytes: 0,
      isBinary: false,
      isLarge: false,
      skipped: true,
      skipReason: safety.reason || 'Permission Engine path safety violation'
    };
  }

  const absPath = safety.resolvedPath;

  // 2. Secret exclusion rules
  if (isSecretFile(normalizedPath) || isSecretFile(absPath)) {
    return {
      path: normalizedPath,
      absolutePath: absPath,
      existsBefore: false,
      sizeBytes: 0,
      isBinary: false,
      isLarge: false,
      skipped: true,
      skipReason: 'Secret or credential file excluded'
    };
  }

  // 3. Handle missing file
  if (!existsSync(absPath)) {
    return {
      path: normalizedPath,
      absolutePath: absPath,
      existsBefore: false,
      sizeBytes: 0,
      isBinary: false,
      isLarge: false,
      skipped: false
    };
  }

  try {
    const stat = await fs.stat(absPath);
    if (!stat.isFile()) {
      return {
        path: normalizedPath,
        absolutePath: absPath,
        existsBefore: false,
        sizeBytes: 0,
        isBinary: false,
        isLarge: false,
        skipped: true,
        skipReason: 'Not a regular file'
      };
    }

    const size = stat.size;
    const isLarge = size > 500 * 1024; // 500 KB limit
    const isBinaryExt = isBinaryExtension(absPath);

    // Read head of file or full content
    if (isLarge) {
      return {
        path: normalizedPath,
        absolutePath: absPath,
        existsBefore: true,
        sizeBytes: size,
        isBinary: isBinaryExt,
        isLarge: true,
        skipped: true,
        skipReason: 'File size exceeds 500 KB limit'
      };
    }

    const fileBuf = await fs.readFile(absPath);
    const isBinary = isBinaryExt || isBinaryBuffer(fileBuf);

    if (isBinary) {
      // Calculate content hash only, do not save contents
      const crypto = await import('node:crypto');
      const hash = crypto.createHash('sha256').update(fileBuf).digest('hex');

      return {
        path: normalizedPath,
        absolutePath: absPath,
        existsBefore: true,
        contentHashBefore: hash,
        sizeBytes: size,
        isBinary: true,
        isLarge: false,
        skipped: true,
        skipReason: 'Binary file content skipped'
      };
    }

    // Normal text file
    const content = fileBuf.toString('utf-8');
    const crypto = await import('node:crypto');
    const hash = crypto.createHash('sha256').update(content).digest('hex');

    return {
      path: normalizedPath,
      absolutePath: absPath,
      existsBefore: true,
      contentHashBefore: hash,
      contentBefore: content,
      sizeBytes: size,
      isBinary: false,
      isLarge: false,
      skipped: false
    };
  } catch (err: any) {
    return {
      path: normalizedPath,
      absolutePath: absPath,
      existsBefore: false,
      sizeBytes: 0,
      isBinary: false,
      isLarge: false,
      skipped: true,
      skipReason: `Failed to read file: ${err.message}`
    };
  }
}

// Discover all source files inside the workspace to snap
export async function discoverWorkspaceFiles(
  cwd: string,
  dir: string = cwd
): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  const ignoreDirs = new Set([
    'node_modules',
    '.git',
    '.ara',
    'dist',
    'build',
    'out',
    'temp',
    '.temp',
    'test-hooks-temp'
  ]);

  const ignoreFiles = new Set([
    'ara.sqlite',
    'test-hooks.sqlite',
    'bun.lock'
  ]);

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const rel = path.relative(cwd, fullPath).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      if (ignoreDirs.has(entry.name) || entry.name.startsWith('.')) {
        continue;
      }
      const childFiles = await discoverWorkspaceFiles(cwd, fullPath);
      files.push(...childFiles);
    } else if (entry.isFile()) {
      if (ignoreFiles.has(entry.name) || isSecretFile(entry.name)) {
        continue;
      }
      files.push(rel);
    }
  }

  return files;
}

// Take complete workspace files snapshot
export async function takeWorkspaceSnapshot(
  cwd: string,
  specificFiles?: string[]
): Promise<CheckpointFileSnapshot[]> {
  const filesToSnapshot = specificFiles || (await discoverWorkspaceFiles(cwd));
  const snapshots: CheckpointFileSnapshot[] = [];

  for (const rel of filesToSnapshot) {
    const snap = await takeFileSnapshot(rel, cwd);
    snapshots.push(snap);
  }

  return snapshots;
}
