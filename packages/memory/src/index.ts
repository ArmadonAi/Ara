import type { Memory, MemoryType } from '@ara/shared';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface MemoryStore {
  save(memory: Omit<Memory, 'id' | 'createdAt' | 'updatedAt'>): Promise<Memory>;
  search(query: string, type?: MemoryType): Promise<Memory[]>;
  loadAll(): Promise<Memory[]>;
}

export class LocalMarkdownMemoryStore implements MemoryStore {
  private memoryDir: string;

  constructor() {
    this.memoryDir = path.resolve(process.cwd(), 'memory');
  }

  private async ensureFilesExist() {
    try {
      await fs.mkdir(this.memoryDir, { recursive: true });
      
      const userPath = path.join(this.memoryDir, 'USER.md');
      try {
        await fs.access(userPath);
      } catch {
        await fs.writeFile(userPath, '# User Profile facts\n\n- **Name:** User\n', 'utf8');
      }

      const memoryPath = path.join(this.memoryDir, 'MEMORY.md');
      try {
        await fs.access(memoryPath);
      } catch {
        await fs.writeFile(memoryPath, '# Episodic & General Facts Memory\n\n- Ara Personal Assistant is active.\n', 'utf8');
      }
    } catch (e) {
      console.error('Failed to ensure memory files exist', e);
    }
  }

  async loadAll(): Promise<Memory[]> {
    await this.ensureFilesExist();
    const list: Memory[] = [];

    // 1. Load USER.md
    try {
      const userPath = path.join(this.memoryDir, 'USER.md');
      const content = await fs.readFile(userPath, 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('-')) {
          const fact = trimmed.replace(/^-\s*/, '').trim();
          if (fact) {
            list.push({
              id: `user-${idx}`,
              type: 'user',
              title: 'ข้อมูลส่วนตัวผู้ใช้',
              content: fact,
              source: 'local-markdown',
              tags: [],
              confidence: 1.0,
              createdAt: new Date(),
              updatedAt: new Date()
            });
          }
        }
      });
    } catch (e) {
      console.error('Failed to load USER.md memory', e);
    }

    // 2. Load MEMORY.md
    try {
      const memoryPath = path.join(this.memoryDir, 'MEMORY.md');
      const content = await fs.readFile(memoryPath, 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('-')) {
          const fact = trimmed.replace(/^-\s*/, '').trim();
          if (fact) {
            list.push({
              id: `episodic-${idx}`,
              type: 'episodic',
              title: 'ความจำระยะยาว',
              content: fact,
              source: 'local-markdown',
              tags: [],
              confidence: 1.0,
              createdAt: new Date(),
              updatedAt: new Date()
            });
          }
        }
      });
    } catch (e) {
      console.error('Failed to load MEMORY.md memory', e);
    }

    return list;
  }

  async save(memory: Omit<Memory, 'id' | 'createdAt' | 'updatedAt'>): Promise<Memory> {
    await this.ensureFilesExist();
    
    const newMemory: Memory = {
      ...memory,
      id: `${memory.type}-${Math.random().toString(36).substring(7)}`,
      source: memory.source || 'local-markdown',
      tags: memory.tags || [],
      confidence: memory.confidence || 1.0,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const fileName = memory.type === 'user' ? 'USER.md' : 'MEMORY.md';
    const filePath = path.join(this.memoryDir, fileName);

    try {
      // Append as a bullet point
      const bullet = `\n- ${memory.content}`;
      await fs.appendFile(filePath, bullet, 'utf8');
    } catch (e) {
      console.error(`Failed to save memory to ${fileName}`, e);
    }

    return newMemory;
  }

  async search(query: string, type?: MemoryType): Promise<Memory[]> {
    const allMemories = await this.loadAll();
    return allMemories.filter(m => {
      const matchType = !type || m.type === type;
      const matchQuery = m.content.toLowerCase().includes(query.toLowerCase()) || 
                         m.title.toLowerCase().includes(query.toLowerCase());
      return matchType && matchQuery;
    });
  }
}
