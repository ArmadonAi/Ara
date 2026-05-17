import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runClawMigration, getOpenClawDir } from '../apps/cli/src/claw/migrate';

describe('OpenClaw Migration Tests', () => {
  const backupOpenClawDir = getOpenClawDir() + '.backup_test';
  const openClawDir = getOpenClawDir();
  
  beforeAll(async () => {
    // Temp backup user's original openclaw folder if exists
    if (existsSync(openClawDir)) {
      await fs.rename(openClawDir, backupOpenClawDir);
    }
    await fs.mkdir(openClawDir, { recursive: true });
  });

  afterAll(async () => {
    // Restore user's original openclaw folder
    if (existsSync(openClawDir)) {
      await fs.rm(openClawDir, { recursive: true, force: true });
    }
    if (existsSync(backupOpenClawDir)) {
      await fs.rename(backupOpenClawDir, openClawDir);
    }
  });

  test('detects when openclaw dir does not exist', async () => {
    // Temporarily rename openClawDir to test missing condition
    const tempDir = openClawDir + '_temp';
    await fs.rename(openClawDir, tempDir);
    
    const summary = await runClawMigration();
    expect(summary.detected).toBe(false);
    
    await fs.rename(tempDir, openClawDir);
  });

  test('successfully migrates full preset (keys, settings, memories, skills)', async () => {
    // 1. Create mock OpenClaw secrets
    await fs.writeFile(
      path.join(openClawDir, '.env'),
      'GEMINI_API_KEY=mock-gemini-key\nOPENAI_API_KEY=mock-openai-key\nGITHUB_TOKEN=mock-github-token\n',
      'utf8'
    );

    // 2. Create mock OpenClaw config
    const configData = {
      defaultModel: 'OpenAI',
      theme: 'dark',
      apiKeys: {
        ANTHROPIC_API_KEY: 'mock-anthropic-key'
      }
    };
    await fs.writeFile(
      path.join(openClawDir, 'config.json'),
      JSON.stringify(configData, null, 2),
      'utf8'
    );

    // 3. Create mock OpenClaw memories
    const memoryDir = path.join(openClawDir, 'memory');
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(
      path.join(memoryDir, 'USER.md'),
      '# Profile\n- **Name:** John Doe\n- **Status:** Developer\n',
      'utf8'
    );
    await fs.writeFile(
      path.join(memoryDir, 'MEMORY.md'),
      '# Episodic\n- Ara Personal Assistant is fully configured\n- Coding in TypeScript\n',
      'utf8'
    );

    // 4. Create mock OpenClaw skills
    const skillsDir = path.join(openClawDir, 'skills');
    await fs.mkdir(path.join(skillsDir, 'test-migrated-skill'), { recursive: true });
    await fs.writeFile(
      path.join(skillsDir, 'test-migrated-skill', 'SKILL.md'),
      '---\nname: test-migrated-skill\ndescription: Test migrated skill from OpenClaw\n---\n## When to use\nTesting\n',
      'utf8'
    );

    // Run dry-run migration first
    const drySummary = await runClawMigration({ dryRun: true, preset: 'full' });
    expect(drySummary.detected).toBe(true);
    expect(drySummary.keysMigrated).toContain('GEMINI_API_KEY');
    expect(drySummary.keysMigrated).toContain('OPENAI_API_KEY');
    expect(drySummary.keysMigrated).toContain('GITHUB_TOKEN');
    expect(drySummary.keysMigrated).toContain('ANTHROPIC_API_KEY');
    expect(drySummary.settingsMigrated.defaultModel).toBe('OpenAI');
    expect(drySummary.settingsMigrated.theme).toBe('dark');
    expect(drySummary.memoriesMigratedCount).toBe(4);
    expect(drySummary.skillsMigratedCount).toBe(1);

    // Make sure nothing was actually written to process.cwd() under dry-run
    expect(existsSync(path.join(process.cwd(), 'skills', 'test-migrated-skill'))).toBe(false);

    // Run actual migration with overwrite
    const summary = await runClawMigration({ dryRun: false, preset: 'full', overwrite: true });
    expect(summary.detected).toBe(true);
    expect(summary.memoriesMigratedCount).toBe(4);
    expect(summary.skillsMigratedCount).toBe(1);

    // Validate that the files exist in CWD now
    const migratedSkillPath = path.join(process.cwd(), 'skills', 'test-migrated-skill', 'SKILL.md');
    expect(existsSync(migratedSkillPath)).toBe(true);

    const migratedSkillContent = await fs.readFile(migratedSkillPath, 'utf8');
    expect(migratedSkillContent).toContain('Test migrated skill from OpenClaw');

    // Cleanup generated files from process.cwd()
    await fs.rm(path.join(process.cwd(), 'skills', 'test-migrated-skill'), { recursive: true, force: true });
  });

  test('successfully migrates user-data preset (excludes secrets/keys)', async () => {
    // Run migration with user-data preset
    const summary = await runClawMigration({ dryRun: true, preset: 'user-data' });
    expect(summary.detected).toBe(true);
    expect(summary.keysMigrated.length).toBe(0); // Explicitly zero secrets!
    expect(summary.settingsMigrated.defaultModel).toBe('OpenAI');
    expect(summary.memoriesMigratedCount).toBe(4);
  });
});
