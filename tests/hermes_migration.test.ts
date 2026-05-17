import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runHermesMigration, getHermesDir } from '../apps/cli/src/claw/migrate';

describe('Hermes Migration Tests', () => {
  const backupHermesDir = getHermesDir() + '.backup_test';
  const hermesDir = getHermesDir();
  
  beforeAll(async () => {
    // Temp backup user's original hermes folder if exists
    if (existsSync(hermesDir)) {
      await fs.rename(hermesDir, backupHermesDir);
    }
    await fs.mkdir(hermesDir, { recursive: true });
  });

  afterAll(async () => {
    // Restore user's original hermes folder
    if (existsSync(hermesDir)) {
      await fs.rm(hermesDir, { recursive: true, force: true });
    }
    if (existsSync(backupHermesDir)) {
      await fs.rename(backupHermesDir, hermesDir);
    }
  });

  test('detects when hermes dir does not exist', async () => {
    // Temporarily rename hermesDir to test missing condition
    const tempDir = hermesDir + '_temp';
    await fs.rename(hermesDir, tempDir);
    
    const summary = await runHermesMigration();
    expect(summary.detected).toBe(false);
    
    await fs.rename(tempDir, hermesDir);
  });

  test('successfully migrates full preset (keys, settings, memories, skills)', async () => {
    // 1. Create mock Hermes secrets
    await fs.writeFile(
      path.join(hermesDir, '.env'),
      'GEMINI_API_KEY=mock-hermes-gemini-key\nOPENAI_API_KEY=mock-hermes-openai-key\nGITHUB_TOKEN=mock-hermes-github-token\n',
      'utf8'
    );

    // 2. Create mock Hermes config in YAML format
    const configYamlContent = `
model: OpenAI
theme: dark
api_base_url: http://localhost:3002
`;
    await fs.writeFile(
      path.join(hermesDir, 'config.yaml'),
      configYamlContent,
      'utf8'
    );

    // 3. Create mock Hermes memories
    const memoriesDir = path.join(hermesDir, 'memories');
    await fs.mkdir(memoriesDir, { recursive: true });
    await fs.writeFile(
      path.join(memoriesDir, 'USER.md'),
      '# Profile\n- **Name:** John Hermes\n- **Status:** Senior Dev\n',
      'utf8'
    );
    await fs.writeFile(
      path.join(memoriesDir, 'MEMORY.md'),
      '# Episodic\n- Hermes Assistant is fully configured\n- Coding in TypeScript\n',
      'utf8'
    );

    // 4. Create mock Hermes skills
    const skillsDir = path.join(hermesDir, 'skills');
    await fs.mkdir(path.join(skillsDir, 'test-migrated-hermes-skill'), { recursive: true });
    await fs.writeFile(
      path.join(skillsDir, 'test-migrated-hermes-skill', 'SKILL.md'),
      '---\nname: test-migrated-hermes-skill\ndescription: Test migrated skill from Hermes\n---\n## When to use\nTesting\n',
      'utf8'
    );

    // Run dry-run migration first
    const drySummary = await runHermesMigration({ dryRun: true, preset: 'full' });
    expect(drySummary.detected).toBe(true);
    expect(drySummary.keysMigrated).toContain('GEMINI_API_KEY');
    expect(drySummary.keysMigrated).toContain('OPENAI_API_KEY');
    expect(drySummary.keysMigrated).toContain('GITHUB_TOKEN');
    expect(drySummary.settingsMigrated.defaultModel).toBe('OpenAI');
    expect(drySummary.settingsMigrated.theme).toBe('dark');
    expect(drySummary.settingsMigrated.apiBaseUrl).toBe('http://localhost:3002');
    expect(drySummary.memoriesMigratedCount).toBe(4);
    expect(drySummary.skillsMigratedCount).toBe(1);

    // Make sure nothing was actually written to process.cwd() under dry-run
    expect(existsSync(path.join(process.cwd(), 'skills', 'test-migrated-hermes-skill'))).toBe(false);

    // Run actual migration with overwrite
    const summary = await runHermesMigration({ dryRun: false, preset: 'full', overwrite: true });
    expect(summary.detected).toBe(true);
    expect(summary.memoriesMigratedCount).toBe(4);
    expect(summary.skillsMigratedCount).toBe(1);

    // Validate that the files exist in CWD now
    const migratedSkillPath = path.join(process.cwd(), 'skills', 'test-migrated-hermes-skill', 'SKILL.md');
    expect(existsSync(migratedSkillPath)).toBe(true);

    const migratedSkillContent = await fs.readFile(migratedSkillPath, 'utf8');
    expect(migratedSkillContent).toContain('Test migrated skill from Hermes');

    // Cleanup generated files from process.cwd()
    await fs.rm(path.join(process.cwd(), 'skills', 'test-migrated-hermes-skill'), { recursive: true, force: true });
  });

  test('successfully migrates user-data preset (excludes secrets/keys)', async () => {
    // Run migration with user-data preset
    const summary = await runHermesMigration({ dryRun: true, preset: 'user-data' });
    expect(summary.detected).toBe(true);
    expect(summary.keysMigrated.length).toBe(0); // Explicitly zero secrets!
    expect(summary.settingsMigrated.defaultModel).toBe('OpenAI');
    expect(summary.memoriesMigratedCount).toBe(4);
  });
});
