import type { Skill } from '@ara/shared';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface SkillLoader {
  listSkills(): Promise<Omit<Skill, 'procedure' | 'output'>[]>;
  loadSkill(name: string): Promise<Skill | undefined>;
}

export class LocalMarkdownSkillLoader implements SkillLoader {
  private skillsDir: string;

  constructor() {
    this.skillsDir = path.resolve(process.cwd(), 'skills');
  }

  private parseYAML(yamlText: string): Record<string, any> {
    const obj: Record<string, any> = {};
    const lines = yamlText.split('\n');
    let currentKey: string | null = null;
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      
      // List item
      if (trimmed.startsWith('-') && currentKey) {
        if (!Array.isArray(obj[currentKey])) {
          obj[currentKey] = [];
        }
        obj[currentKey].push(trimmed.substring(1).trim());
        continue;
      }
      
      // Key-value pair
      const colonIndex = trimmed.indexOf(':');
      if (colonIndex !== -1) {
        const key = trimmed.substring(0, colonIndex).trim();
        const val = trimmed.substring(colonIndex + 1).trim();
        currentKey = key;
        
        if (val) {
          obj[key] = val;
        } else {
          obj[key] = [];
        }
      }
    }
    return obj;
  }

  private async readAllSkills(): Promise<Skill[]> {
    const list: Skill[] = [];
    try {
      const entries = await fs.readdir(this.skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillFilePath = path.join(this.skillsDir, entry.name, 'SKILL.md');
          try {
            const content = await fs.readFile(skillFilePath, 'utf8');
            
            // Extract frontmatter
            const frontmatterMatch = content.match(/^---\r?\n([\s\S]+?)\r?\n---/);
            if (!frontmatterMatch) continue;
            
            const frontmatterText = frontmatterMatch[1] || '';
            const meta = this.parseYAML(frontmatterText);
            
            // Extract markdown sections
            const whenToUseMatch = content.match(/## When to use\r?\n([\s\S]+?)(?=\r?\n##|$)/i);
            const inputsMatch = content.match(/## Inputs\r?\n([\s\S]+?)(?=\r?\n##|$)/i);
            const procedureMatch = content.match(/## Procedure\r?\n([\s\S]+?)(?=\r?\n##|$)/i);
            const outputMatch = content.match(/## Output\r?\n([\s\S]+?)(?=\r?\n##|$)/i);

            const whenToUse = whenToUseMatch && whenToUseMatch[1] ? whenToUseMatch[1].trim() : '';
            
            const inputs = inputsMatch && inputsMatch[1]
              ? inputsMatch[1].split('\n').map(l => l.trim().replace(/^-\s*/, '')).filter(Boolean)
              : [];
              
            const procedure = procedureMatch && procedureMatch[1]
              ? procedureMatch[1].split('\n').map(l => l.trim().replace(/^\d+\.\s*/, '')).filter(Boolean)
              : [];
              
            const output = outputMatch && outputMatch[1] ? outputMatch[1].trim() : '';

            list.push({
              name: meta.name || entry.name,
              description: meta.description || '',
              tags: meta.tags || [],
              whenToUse,
              inputs,
              procedure,
              output
            });
          } catch (e) {
            // Skip folders without SKILL.md
          }
        }
      }
    } catch (e) {
      console.error('Failed to read skills folder', e);
    }

    // Fallback if no skills are found on filesystem
    if (list.length === 0) {
      list.push({
        name: 'code-review',
        description: 'Review code changes for bugs, security, architecture, and maintainability.',
        tags: ['coding', 'review'],
        whenToUse: 'Use this when the user asks to review code, diffs, PRs, or architecture changes.',
        inputs: ['repository path', 'changed files or diff', 'user goal'],
        procedure: [
          'Inspect git status and diff',
          'Identify changed files',
          'Check for obvious bugs',
          'Check test coverage',
          'Check security risks',
          'Suggest focused fixes',
          'Run tests if safe and approved'
        ],
        output: 'summary, issues by severity, suggested patch, verification steps'
      });
    }

    return list;
  }

  async listSkills(): Promise<Omit<Skill, 'procedure' | 'output'>[]> {
    const list = await this.readAllSkills();
    return list.map(({ name, description, tags, whenToUse, inputs }) => ({
      name,
      description,
      tags,
      whenToUse,
      inputs
    }));
  }

  async loadSkill(name: string): Promise<Skill | undefined> {
    const list = await this.readAllSkills();
    return list.find(s => s.name === name);
  }
}
