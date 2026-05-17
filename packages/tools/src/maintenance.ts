import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Compact a JSONL file by keeping only the most recent N entries.
 * Returns { originalLines, keptLines, removedLines }.
 */
export function compactJSONL(filePath: string, keep: number = 1000): { ok: boolean; originalLines: number; keptLines: number; removedLines: number; error?: string } {
  try {
    if (!fs.existsSync(filePath)) return { ok: true, originalLines: 0, keptLines: 0, removedLines: 0 };
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);
    const originalLines = lines.length;
    if (originalLines <= keep) return { ok: true, originalLines, keptLines: originalLines, removedLines: 0 };
    const kept = lines.slice(-keep);
    fs.writeFileSync(filePath, kept.join('\n') + '\n', 'utf8');
    return { ok: true, originalLines, keptLines: kept.length, removedLines: originalLines - kept.length };
  } catch (e: any) {
    return { ok: false, originalLines: 0, keptLines: 0, removedLines: 0, error: e.message };
  }
}

/**
 * Compact multiple JSONL files in a directory.
 * Only processes files matching *.jsonl.
 */
export function compactJSONLDir(dirPath: string, keep: number = 1000): { results: Record<string, { originalLines: number; keptLines: number; removedLines: number; error?: string }> } {
  const results: Record<string, any> = {};
  try {
    if (!fs.existsSync(dirPath)) return { results };
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
    for (const file of files) {
      results[file] = compactJSONL(path.join(dirPath, file), keep);
    }
  } catch {}
  return { results };
}

/**
 * Get total size of a JSONL file in bytes.
 */
export function getJSONLSize(filePath: string): number {
  try {
    if (!fs.existsSync(filePath)) return 0;
    return fs.statSync(filePath).size;
  } catch { return 0; }
}

/**
 * Get JSONL stats for a directory.
 */
export function getJSONLDirStats(dirPath: string): { files: number; totalBytes: number; totalLines: number } {
  let files = 0, totalBytes = 0, totalLines = 0;
  try {
    if (!fs.existsSync(dirPath)) return { files, totalBytes, totalLines };
    const entries = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
    for (const entry of entries) {
      const fp = path.join(dirPath, entry);
      totalBytes += fs.statSync(fp).size;
      const raw = fs.readFileSync(fp, 'utf8');
      totalLines += raw.trim().split('\n').filter(Boolean).length;
      files++;
    }
  } catch {}
  return { files, totalBytes, totalLines };
}
