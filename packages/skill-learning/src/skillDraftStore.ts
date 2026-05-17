import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SkillDraft, DraftStatus } from './types';

const DRAFTS_DIR = '.ara/skill-drafts';

function getDraftsDir(cwd: string): string {
  return path.join(cwd, DRAFTS_DIR);
}

function getDraftPath(cwd: string, id: string): string {
  return path.join(getDraftsDir(cwd), `${id}.json`);
}

async function ensureDir(dir: string): Promise<void> {
  try { await fs.mkdir(dir, { recursive: true }); } catch {}
}

export async function saveDraft(draft: SkillDraft, cwd: string = process.cwd()): Promise<SkillDraft> {
  const dir = getDraftsDir(cwd);
  await ensureDir(dir);
  await fs.writeFile(getDraftPath(cwd, draft.id), JSON.stringify(draft, null, 2), 'utf8');
  return draft;
}

export async function loadDraft(id: string, cwd: string = process.cwd()): Promise<SkillDraft | null> {
  try {
    const raw = await fs.readFile(getDraftPath(cwd, id), 'utf8');
    return JSON.parse(raw) as SkillDraft;
  } catch {
    return null;
  }
}

export async function listDrafts(cwd: string = process.cwd()): Promise<SkillDraft[]> {
  const dir = getDraftsDir(cwd);
  try {
    const files = await fs.readdir(dir);
    const drafts: SkillDraft[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(dir, file), 'utf8');
        drafts.push(JSON.parse(raw) as SkillDraft);
      } catch {}
    }
    return drafts.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  } catch {
    return [];
  }
}

export async function updateDraftStatus(
  id: string, status: DraftStatus, cwd: string = process.cwd(),
  extra?: Partial<SkillDraft>,
): Promise<SkillDraft | null> {
  const draft = await loadDraft(id, cwd);
  if (!draft) return null;
  draft.status = status;
  draft.updatedAt = new Date().toISOString();
  if (status === 'approved') draft.approvedAt = new Date().toISOString();
  if (status === 'rejected') draft.rejectedAt = new Date().toISOString();
  if (extra) Object.assign(draft, extra);
  await saveDraft(draft, cwd);
  return draft;
}
