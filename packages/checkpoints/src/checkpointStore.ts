import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import type { Checkpoint } from './types';

// Helper to get safe file name for snapshot files on disk
export function encodeFilePath(relPath: string): string {
  return Buffer.from(relPath).toString('hex') + '.snapshot';
}

export function decodeFilePath(encodedName: string): string {
  const hex = encodedName.replace(/\.snapshot$/, '');
  return Buffer.from(hex, 'hex').toString('utf8');
}

export class CheckpointStore {
  private baseDir: string;
  private indexPath: string;

  constructor(cwd: string) {
    this.baseDir = path.join(cwd, '.ara', 'checkpoints');
    this.indexPath = path.join(this.baseDir, 'index.json');
  }

  // Ensure base storage structure is created
  async ensureDirs(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
    if (!existsSync(this.indexPath)) {
      await fs.writeFile(this.indexPath, '[]', 'utf8');
    }
  }

  // Load checkpoints list from index.json
  async loadIndex(): Promise<Checkpoint[]> {
    await this.ensureDirs();
    try {
      const indexRaw = await fs.readFile(this.indexPath, 'utf8');
      return JSON.parse(indexRaw) as Checkpoint[];
    } catch (e) {
      return [];
    }
  }

  // Save checkpoints list to index.json
  async saveIndex(index: Checkpoint[]): Promise<void> {
    await this.ensureDirs();
    // Sort index by createdAt descending
    index.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    await fs.writeFile(this.indexPath, JSON.stringify(index, null, 2), 'utf8');
  }

  // Get a single checkpoint by ID
  async getCheckpoint(id: string): Promise<Checkpoint | null> {
    const checkpointDir = path.join(this.baseDir, id);
    const checkpointPath = path.join(checkpointDir, 'checkpoint.json');
    
    if (!existsSync(checkpointPath)) {
      // Fallback: check index
      const index = await this.loadIndex();
      const found = index.find(c => c.id === id);
      return found || null;
    }

    try {
      const raw = await fs.readFile(checkpointPath, 'utf8');
      return JSON.parse(raw) as Checkpoint;
    } catch (e) {
      return null;
    }
  }

  // Save a new checkpoint to storage
  async saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
    await this.ensureDirs();
    const checkpointDir = path.join(this.baseDir, checkpoint.id);
    const filesDir = path.join(checkpointDir, 'files');

    await fs.mkdir(filesDir, { recursive: true });

    // 1. Write file contents to files/ folder for inspecting/restoring
    for (const file of checkpoint.files) {
      if (file.existsBefore && file.contentBefore !== undefined && !file.skipped) {
        const encodedName = encodeFilePath(file.path);
        const snapshotFilePath = path.join(filesDir, encodedName);
        await fs.writeFile(snapshotFilePath, file.contentBefore, 'utf8');
      }
    }

    // 2. Write session snapshot metadata
    const sessionPath = path.join(checkpointDir, 'session.json');
    await fs.writeFile(
      sessionPath,
      JSON.stringify(checkpoint.sessionSnapshot, null, 2),
      'utf8'
    );

    // 3. Write checkpoint metadata (without duplicating large file contents)
    const metadataCheckpoint = {
      ...checkpoint,
      // Strip contentBefore from index and metadata to avoid bloating memory/disk
      files: checkpoint.files.map(f => ({
        ...f,
        contentBefore: undefined
      }))
    };

    const checkpointPath = path.join(checkpointDir, 'checkpoint.json');
    await fs.writeFile(
      checkpointPath,
      JSON.stringify(metadataCheckpoint, null, 2),
      'utf8'
    );

    // 4. Update index.json
    const index = await this.loadIndex();
    // Prevent duplicate entries
    const filteredIndex = index.filter(c => c.id !== checkpoint.id);
    filteredIndex.push(metadataCheckpoint);
    await this.saveIndex(filteredIndex);
  }

  // Read saved file content from snapshot storage
  async getSnapshotFileContent(checkpointId: string, relPath: string): Promise<string | null> {
    const encodedName = encodeFilePath(relPath);
    const snapshotFilePath = path.join(this.baseDir, checkpointId, 'files', encodedName);
    
    if (existsSync(snapshotFilePath)) {
      return fs.readFile(snapshotFilePath, 'utf8');
    }
    return null;
  }

  // Delete checkpoint and its files from disk and index
  async deleteCheckpoint(id: string): Promise<boolean> {
    await this.ensureDirs();
    const checkpointDir = path.join(this.baseDir, id);
    
    if (existsSync(checkpointDir)) {
      await fs.rm(checkpointDir, { recursive: true, force: true });
    }

    const index = await this.loadIndex();
    const filtered = index.filter(c => c.id !== id);
    await this.saveIndex(filtered);
    return true;
  }
}
