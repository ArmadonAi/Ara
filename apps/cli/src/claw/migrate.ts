import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ApiClient } from '../api/client';
import { loadConfig, saveConfig } from '../config/manager';

export interface MigrationOptions {
  dryRun?: boolean;
  preset?: 'full' | 'user-data';
  overwrite?: boolean;
}

export interface MigrationSummary {
  detected: boolean;
  keysMigrated: string[];
  settingsMigrated: Record<string, any>;
  memoriesMigratedCount: number;
  skillsMigratedCount: number;
  warnings: string[];
}

export function getOpenClawDir(): string {
  return path.join(os.homedir(), '.openclaw');
}

export async function detectOpenClaw(): Promise<boolean> {
  const dir = getOpenClawDir();
  return existsSync(dir);
}

export async function runClawMigration(options: MigrationOptions = {}): Promise<MigrationSummary> {
  const openClawDir = getOpenClawDir();
  const summary: MigrationSummary = {
    detected: false,
    keysMigrated: [],
    settingsMigrated: {},
    memoriesMigratedCount: 0,
    skillsMigratedCount: 0,
    warnings: []
  };

  if (!existsSync(openClawDir)) {
    return summary;
  }

  summary.detected = true;
  const isFull = !options.preset || options.preset === 'full';
  const dryRun = !!options.dryRun;
  const overwrite = !!options.overwrite;

  // 1. Migrate API Keys / Secrets
  if (isFull) {
    const envPath = path.join(openClawDir, '.env');
    const configPath = path.join(openClawDir, 'config.json');
    const keysFound: Record<string, string> = {};

    // Check ~/.openclaw/.env
    if (existsSync(envPath)) {
      try {
        const content = await fs.readFile(envPath, 'utf8');
        const lines = content.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('#')) {
            const idx = trimmed.indexOf('=');
            if (idx !== -1) {
              const k = trimmed.slice(0, idx).trim();
              const v = trimmed.slice(idx + 1).trim();
              if (k.endsWith('_API_KEY') || k === 'GITHUB_TOKEN') {
                keysFound[k] = v;
              }
            }
          }
        }
      } catch (err: any) {
        summary.warnings.push(`Failed to read OpenClaw .env: ${err.message}`);
      }
    }

    // Check ~/.openclaw/config.json for apiKeys
    if (existsSync(configPath)) {
      try {
        const raw = await fs.readFile(configPath, 'utf8');
        const parsed = JSON.parse(raw);
        const apiKeys = parsed.apiKeys || parsed;
        if (apiKeys && typeof apiKeys === 'object') {
          for (const [k, v] of Object.entries(apiKeys)) {
            if (typeof v === 'string' && (k.endsWith('_API_KEY') || k === 'GITHUB_TOKEN')) {
              keysFound[k] = v;
            }
          }
        }
      } catch (err: any) {
        summary.warnings.push(`Failed to read OpenClaw config.json keys: ${err.message}`);
      }
    }

    // Write keys to Ara
    if (Object.keys(keysFound).length > 0) {
      if (!dryRun) {
        try {
          const client = new ApiClient();
          // Write to local Ara env using API
          const currentKeys = await client.getConfigKeys().catch(() => ({}));
          const keysToSave: Record<string, string> = {};
          
          for (const [k, v] of Object.entries(keysFound)) {
            if (overwrite || !currentKeys[k]) {
              keysToSave[k] = v;
              summary.keysMigrated.push(k);
            } else {
              summary.warnings.push(`Key ${k} already exists in Ara. Use --overwrite to replace.`);
            }
          }

          if (Object.keys(keysToSave).length > 0) {
            await client.setConfigKeys(keysToSave);
          }
        } catch (err: any) {
          summary.warnings.push(`Failed to save migrated keys via Ara API: ${err.message}`);
        }
      } else {
        for (const k of Object.keys(keysFound)) {
          summary.keysMigrated.push(k);
        }
      }
    }
  }

  // 2. Migrate General Settings
  const openClawConfigPath = path.join(openClawDir, 'config.json');
  if (existsSync(openClawConfigPath)) {
    try {
      const raw = await fs.readFile(openClawConfigPath, 'utf8');
      const parsed = JSON.parse(raw);
      
      const mappedSettings: Record<string, any> = {};
      if (parsed.defaultModel) mappedSettings.defaultModel = parsed.defaultModel;
      if (parsed.theme) mappedSettings.theme = parsed.theme;
      if (parsed.apiBaseUrl) mappedSettings.apiBaseUrl = parsed.apiBaseUrl;

      if (Object.keys(mappedSettings).length > 0) {
        summary.settingsMigrated = mappedSettings;
        if (!dryRun) {
          const araConfig = loadConfig();
          let modified = false;
          
          for (const [k, v] of Object.entries(mappedSettings)) {
            if (overwrite || (araConfig as any)[k] === null || (araConfig as any)[k] === undefined) {
              (araConfig as any)[k] = v;
              modified = true;
            } else {
              summary.warnings.push(`Setting "${k}" already exists in Ara config. Use --overwrite to replace.`);
            }
          }

          if (modified) {
            saveConfig(araConfig);
          }
        }
      }
    } catch (err: any) {
      summary.warnings.push(`Failed to migrate settings: ${err.message}`);
    }
  }

  // 3. Migrate Memories
  const openClawMemoryDir = path.join(openClawDir, 'memory');
  if (existsSync(openClawMemoryDir)) {
    try {
      const files = await fs.readdir(openClawMemoryDir);
      const araMemoryDir = path.join(process.cwd(), 'memory');
      if (!dryRun && !existsSync(araMemoryDir)) {
        await fs.mkdir(araMemoryDir, { recursive: true });
      }

      for (const file of files) {
        if (file.endsWith('.md') || file.endsWith('.txt')) {
          const openClawFile = path.join(openClawMemoryDir, file);
          const targetFileName = file.toUpperCase().startsWith('USER') ? 'USER.md' : 'MEMORY.md';
          const araFile = path.join(araMemoryDir, targetFileName);

          const content = await fs.readFile(openClawFile, 'utf8');
          const lines = content.split('\n');
          const factsToAppend: string[] = [];

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('-') || trimmed.startsWith('*')) {
              const fact = trimmed.replace(/^[-*]\s*/, '').trim();
              if (fact) {
                factsToAppend.push(fact);
              }
            }
          }

          if (factsToAppend.length > 0) {
            summary.memoriesMigratedCount += factsToAppend.length;
            if (!dryRun) {
              let existingFacts = new Set<string>();
              if (existsSync(araFile)) {
                const existingContent = await fs.readFile(araFile, 'utf8');
                existingContent.split('\n').forEach(l => {
                  const t = l.trim();
                  if (t.startsWith('-')) {
                    existingFacts.add(t.replace(/^-\s*/, '').trim().toLowerCase());
                  }
                });
              } else {
                const title = targetFileName === 'USER.md' ? '# User Profile facts\n\n' : '# Long-Term Memory facts\n\n';
                await fs.writeFile(araFile, title, 'utf8');
              }

              let appendText = '';
              for (const fact of factsToAppend) {
                if (overwrite || !existingFacts.has(fact.toLowerCase())) {
                  appendText += `\n- ${fact}`;
                }
              }

              if (appendText) {
                await fs.appendFile(araFile, appendText, 'utf8');
              }
            }
          }
        }
      }
    } catch (err: any) {
      summary.warnings.push(`Failed to migrate memories: ${err.message}`);
    }
  }

  // 4. Migrate Skills
  const openClawSkillsDir = path.join(openClawDir, 'skills');
  if (existsSync(openClawSkillsDir)) {
    try {
      const skills = await fs.readdir(openClawSkillsDir, { withFileTypes: true });
      const araSkillsDir = path.join(process.cwd(), 'skills');
      
      if (!dryRun && !existsSync(araSkillsDir)) {
        await fs.mkdir(araSkillsDir, { recursive: true });
      }

      for (const skill of skills) {
        if (skill.isDirectory()) {
          const openClawSkillDir = path.join(openClawSkillsDir, skill.name);
          const araSkillDir = path.join(araSkillsDir, skill.name);
          const skillFilePath = path.join(openClawSkillDir, 'SKILL.md');

          if (existsSync(skillFilePath)) {
            summary.skillsMigratedCount++;
            if (!dryRun) {
              if (existsSync(araSkillDir)) {
                if (overwrite) {
                  await fs.rm(araSkillDir, { recursive: true, force: true });
                  await copyDir(openClawSkillDir, araSkillDir);
                } else {
                  summary.warnings.push(`Skill "${skill.name}" already exists in Ara skills list. Use --overwrite to replace.`);
                }
              } else {
                await copyDir(openClawSkillDir, araSkillDir);
              }
            }
          }
        }
      }
    } catch (err: any) {
      summary.warnings.push(`Failed to migrate skills: ${err.message}`);
    }
  }

  return summary;
}

async function copyDir(src: string, dest: string) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

export function getHermesDir(): string {
  return path.join(os.homedir(), '.hermes');
}

export async function detectHermes(): Promise<boolean> {
  const dir = getHermesDir();
  return existsSync(dir);
}

function parseSimpleYaml(content: string): Record<string, any> {
  const result: Record<string, any> = {};
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx !== -1) {
      const key = trimmed.slice(0, colonIdx).trim();
      let val = trimmed.slice(colonIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      result[key] = val;
    }
  }
  return result;
}

export async function runHermesMigration(options: MigrationOptions = {}): Promise<MigrationSummary> {
  const hermesDir = getHermesDir();
  const summary: MigrationSummary = {
    detected: false,
    keysMigrated: [],
    settingsMigrated: {},
    memoriesMigratedCount: 0,
    skillsMigratedCount: 0,
    warnings: []
  };

  if (!existsSync(hermesDir)) {
    return summary;
  }

  summary.detected = true;
  const isFull = !options.preset || options.preset === 'full';
  const dryRun = !!options.dryRun;
  const overwrite = !!options.overwrite;

  // 1. Migrate API Keys / Secrets
  if (isFull) {
    const envPath = path.join(hermesDir, '.env');
    const configPath = path.join(hermesDir, 'config.json');
    const configYamlPath = path.join(hermesDir, 'config.yaml');
    const keysFound: Record<string, string> = {};

    // Check ~/.hermes/.env
    if (existsSync(envPath)) {
      try {
        const content = await fs.readFile(envPath, 'utf8');
        const lines = content.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('#')) {
            const idx = trimmed.indexOf('=');
            if (idx !== -1) {
              const k = trimmed.slice(0, idx).trim();
              const v = trimmed.slice(idx + 1).trim();
              if (k.endsWith('_API_KEY') || k === 'GITHUB_TOKEN') {
                keysFound[k] = v;
              }
            }
          }
        }
      } catch (err: any) {
        summary.warnings.push(`Failed to read Hermes .env: ${err.message}`);
      }
    }

    // Check config.json keys
    if (existsSync(configPath)) {
      try {
        const raw = await fs.readFile(configPath, 'utf8');
        const parsed = JSON.parse(raw);
        const apiKeys = parsed.apiKeys || parsed;
        if (apiKeys && typeof apiKeys === 'object') {
          for (const [k, v] of Object.entries(apiKeys)) {
            if (typeof v === 'string' && (k.endsWith('_API_KEY') || k === 'GITHUB_TOKEN')) {
              keysFound[k] = v;
            }
          }
        }
      } catch (err: any) {
        summary.warnings.push(`Failed to read Hermes config.json keys: ${err.message}`);
      }
    }

    // Check config.yaml keys
    if (existsSync(configYamlPath)) {
      try {
        const raw = await fs.readFile(configYamlPath, 'utf8');
        const parsed = parseSimpleYaml(raw);
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string' && (k.endsWith('_API_KEY') || k === 'GITHUB_TOKEN')) {
            keysFound[k] = v;
          }
        }
      } catch (err: any) {
        summary.warnings.push(`Failed to read Hermes config.yaml keys: ${err.message}`);
      }
    }

    // Write keys to Ara
    if (Object.keys(keysFound).length > 0) {
      if (!dryRun) {
        try {
          const client = new ApiClient();
          const currentKeys = await client.getConfigKeys().catch(() => ({}));
          const keysToSave: Record<string, string> = {};
          
          for (const [k, v] of Object.entries(keysFound)) {
            if (overwrite || !currentKeys[k]) {
              keysToSave[k] = v;
              summary.keysMigrated.push(k);
            } else {
              summary.warnings.push(`Key ${k} already exists in Ara. Use --overwrite to replace.`);
            }
          }

          if (Object.keys(keysToSave).length > 0) {
            await client.setConfigKeys(keysToSave);
          }
        } catch (err: any) {
          summary.warnings.push(`Failed to save migrated keys via Ara API: ${err.message}`);
        }
      } else {
        for (const k of Object.keys(keysFound)) {
          summary.keysMigrated.push(k);
        }
      }
    }
  }

  // 2. Migrate General Settings
  const configJsonPath = path.join(hermesDir, 'config.json');
  const configYamlPath = path.join(hermesDir, 'config.yaml');
  let settingsFound: Record<string, any> = {};

  if (existsSync(configJsonPath)) {
    try {
      const raw = await fs.readFile(configJsonPath, 'utf8');
      settingsFound = JSON.parse(raw);
    } catch (err: any) {
      summary.warnings.push(`Failed to read Hermes config.json: ${err.message}`);
    }
  } else if (existsSync(configYamlPath)) {
    try {
      const raw = await fs.readFile(configYamlPath, 'utf8');
      settingsFound = parseSimpleYaml(raw);
    } catch (err: any) {
      summary.warnings.push(`Failed to read Hermes config.yaml: ${err.message}`);
    }
  }

  const mappedSettings: Record<string, any> = {};
  const modelVal = settingsFound.model || settingsFound.defaultModel;
  if (modelVal) mappedSettings.defaultModel = modelVal;
  if (settingsFound.theme) mappedSettings.theme = settingsFound.theme;
  const apiBaseVal = settingsFound.api_base_url || settingsFound.apiBaseUrl;
  if (apiBaseVal) mappedSettings.apiBaseUrl = apiBaseVal;

  if (Object.keys(mappedSettings).length > 0) {
    summary.settingsMigrated = mappedSettings;
    if (!dryRun) {
      const araConfig = loadConfig();
      let modified = false;
      
      for (const [k, v] of Object.entries(mappedSettings)) {
        if (overwrite || (araConfig as any)[k] === null || (araConfig as any)[k] === undefined) {
          (araConfig as any)[k] = v;
          modified = true;
        } else {
          summary.warnings.push(`Setting "${k}" already exists in Ara config. Use --overwrite to replace.`);
        }
      }

      if (modified) {
        saveConfig(araConfig);
      }
    }
  }

  // 3. Migrate Memories
  let hermesMemoryDir = path.join(hermesDir, 'memories');
  if (!existsSync(hermesMemoryDir)) {
    hermesMemoryDir = path.join(hermesDir, 'memory');
  }

  if (existsSync(hermesMemoryDir)) {
    try {
      const files = await fs.readdir(hermesMemoryDir);
      const araMemoryDir = path.join(process.cwd(), 'memory');
      if (!dryRun && !existsSync(araMemoryDir)) {
        await fs.mkdir(araMemoryDir, { recursive: true });
      }

      for (const file of files) {
        if (file.endsWith('.md') || file.endsWith('.txt')) {
          const hermesFile = path.join(hermesMemoryDir, file);
          const targetFileName = file.toUpperCase().startsWith('USER') ? 'USER.md' : 'MEMORY.md';
          const araFile = path.join(araMemoryDir, targetFileName);

          const content = await fs.readFile(hermesFile, 'utf8');
          const lines = content.split('\n');
          const factsToAppend: string[] = [];

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('-') || trimmed.startsWith('*')) {
              const fact = trimmed.replace(/^[-*]\s*/, '').trim();
              if (fact) {
                factsToAppend.push(fact);
              }
            }
          }

          if (factsToAppend.length > 0) {
            summary.memoriesMigratedCount += factsToAppend.length;
            if (!dryRun) {
              let existingFacts = new Set<string>();
              if (existsSync(araFile)) {
                const existingContent = await fs.readFile(araFile, 'utf8');
                existingContent.split('\n').forEach(l => {
                  const t = l.trim();
                  if (t.startsWith('-')) {
                    existingFacts.add(t.replace(/^-\s*/, '').trim().toLowerCase());
                  }
                });
              } else {
                const title = targetFileName === 'USER.md' ? '# User Profile facts\n\n' : '# Long-Term Memory facts\n\n';
                await fs.writeFile(araFile, title, 'utf8');
              }

              let appendText = '';
              for (const fact of factsToAppend) {
                if (overwrite || !existingFacts.has(fact.toLowerCase())) {
                  appendText += `\n- ${fact}`;
                }
              }

              if (appendText) {
                await fs.appendFile(araFile, appendText, 'utf8');
              }
            }
          }
        }
      }
    } catch (err: any) {
      summary.warnings.push(`Failed to migrate memories: ${err.message}`);
    }
  }

  // 4. Migrate Skills
  const hermesSkillsDir = path.join(hermesDir, 'skills');
  if (existsSync(hermesSkillsDir)) {
    try {
      const skills = await fs.readdir(hermesSkillsDir, { withFileTypes: true });
      const araSkillsDir = path.join(process.cwd(), 'skills');
      
      if (!dryRun && !existsSync(araSkillsDir)) {
        await fs.mkdir(araSkillsDir, { recursive: true });
      }

      for (const skill of skills) {
        if (skill.isDirectory()) {
          const hermesSkillDir = path.join(hermesSkillsDir, skill.name);
          const araSkillDir = path.join(araSkillsDir, skill.name);
          const skillFilePath = path.join(hermesSkillDir, 'SKILL.md');

          if (existsSync(skillFilePath)) {
            summary.skillsMigratedCount++;
            if (!dryRun) {
              if (existsSync(araSkillDir)) {
                if (overwrite) {
                  await fs.rm(araSkillDir, { recursive: true, force: true });
                  await copyDir(hermesSkillDir, araSkillDir);
                } else {
                  summary.warnings.push(`Skill "${skill.name}" already exists in Ara skills list. Use --overwrite to replace.`);
                }
              } else {
                await copyDir(hermesSkillDir, araSkillDir);
              }
            }
          }
        }
      }
    } catch (err: any) {
      summary.warnings.push(`Failed to migrate skills: ${err.message}`);
    }
  }

  return summary;
}
