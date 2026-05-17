import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { SkillVersion, SkillDraft } from './types';
import { writeSkillLearningAudit } from './skillLearningAudit';

const SKILLS_DIR = 'skills';

function getSkillDir(cwd: string, skillName: string): string {
  return path.join(cwd, SKILLS_DIR, skillName);
}

async function ensureDir(dir: string): Promise<void> {
  try { await fs.mkdir(dir, { recursive: true }); } catch {}
}

/**
 * Check if a skill already exists.
 */
export async function skillExists(skillName: string, cwd: string = process.cwd()): Promise<boolean> {
  const skillDir = getSkillDir(cwd, skillName);
  try {
    await fs.access(path.join(skillDir, 'SKILL.md'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the latest version number of an existing skill.
 */
export async function getLatestVersion(skillName: string, cwd: string = process.cwd()): Promise<number> {
  const skillDir = getSkillDir(cwd, skillName);
  let maxVer = 0;
  // Check versions directory
  const versionsDir = path.join(skillDir, 'versions');
  try {
    const files = await fs.readdir(versionsDir);
    const versions = files
      .filter(f => f.startsWith('v') && f.endsWith('.md'))
      .map(f => parseInt(f.slice(1).replace('.md', ''), 10))
      .filter(n => !isNaN(n));
    maxVer = Math.max(maxVer, ...versions);
  } catch {}
  // Current SKILL.md counts as version 1 if exists
  try {
    await fs.access(path.join(skillDir, 'SKILL.md'));
    maxVer = Math.max(maxVer, 1);
  } catch {}
  return maxVer;
}

/**
 * Approve a draft and write it as a live skill.
 * If skill exists, creates a new version.
 */
export async function approveDraft(
  draft: SkillDraft,
  cwd: string = process.cwd(),
): Promise<{ skillName: string; version: number; isNew: boolean }> {
  const skillName = draft.proposedSkillName;
  const exists = await skillExists(skillName, cwd);
  const skillDir = getSkillDir(cwd, skillName);
  const versionsDir = path.join(skillDir, 'versions');

  await ensureDir(versionsDir);

  // Generate SKILL.md content
  const frontmatterYaml = Object.entries(draft.frontmatter)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n');

  const skillContent = `---\n${frontmatterYaml}\n---\n\n${draft.body}`;
  const contentHash = crypto.createHash('sha256').update(skillContent).digest('hex').slice(0, 16);

  let version = 1;
  const changelogParts: string[] = [];

  if (exists) {
    version = (await getLatestVersion(skillName, cwd)) + 1;
    // Move current SKILL.md to versions
    try {
      const currentContent = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8');
      await fs.writeFile(path.join(versionsDir, `v${version - 1}.md`), currentContent, 'utf8');
      changelogParts.push(`Previous version v${version - 1} archived`);
    } catch {}
  }

  // Write new SKILL.md
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), skillContent, 'utf8');

  // Write skill metadata
  const meta = {
    skillName,
    currentVersion: version,
    contentHash,
    draftId: draft.id,
    createdAt: new Date().toISOString(),
    versions: exists ? (await getLatestVersion(skillName, cwd)) : 0,
  };
  await fs.writeFile(path.join(skillDir, 'skill.json'), JSON.stringify(meta, null, 2), 'utf8');

  changelogParts.push(`Approved from draft ${draft.id}`);

  const sv: SkillVersion = {
    skillName,
    version,
    draftId: draft.id,
    contentHash,
    changelog: changelogParts.join('; '),
    createdAt: new Date().toISOString(),
    createdBy: 'user',
    previousVersion: exists ? version - 1 : undefined,
  };

  writeSkillLearningAudit('skill_learning.draft_approved', {
    draftId: draft.id, skillName,
    details: `version=${version} ${exists ? 'updated' : 'created'}`,
  });

  writeSkillLearningAudit('skill_learning.skill_version_created', {
    skillName,
    details: `version=${version} draftId=${draft.id}`,
  });

  return { skillName, version, isNew: !exists };
}
