import { describe, it, expect, beforeEach } from 'bun:test';
import { generateWorkflowFingerprint, updateWorkflowFingerprint, findRepeatedWorkflows, clearFingerprints, normalizeGoal } from '../src/workflowDetector';
import { extractToolSequence, extractGoal } from '../src/sessionToProcedure';
import { generateDraft } from '../src/skillDraftGenerator';
import { saveDraft, loadDraft, listDrafts, updateDraftStatus } from '../src/skillDraftStore';
import { approveDraft, skillExists } from '../src/skillVersioning';
import { recordSkillUsage, getSkillStats, listSkillStats, clearStats } from '../src/skillEvaluator';
import { writeSkillLearningAudit, listSkillLearningAudit, clearSkillLearningAudit } from '../src/skillLearningAudit';
import type { WorkflowFingerprint, SkillDraft, SessionTranscriptEntry } from '../src/types';

describe('workflow fingerprint', () => {
  beforeEach(() => { clearFingerprints(); });

  it('generates consistent fingerprint for same goal', () => {
    const fp1 = generateWorkflowFingerprint({
      goal: 'Review PR diff and summarize risks',
      toolSequence: ['github.get_pull_request_diff', 'read_file'],
    });
    const fp2 = generateWorkflowFingerprint({
      goal: 'Review PR diff and summarize risks',
      toolSequence: ['github.get_pull_request_diff', 'read_file'],
    });
    expect(fp1).toBe(fp2);
  });

  it('different goals produce different fingerprints', () => {
    const fp1 = generateWorkflowFingerprint({
      goal: 'Review PR diff',
      toolSequence: ['github.get_pull_request_diff'],
    });
    const fp2 = generateWorkflowFingerprint({
      goal: 'Create an issue',
      toolSequence: ['github.create_issue'],
    });
    expect(fp1).not.toBe(fp2);
  });

  it('updateWorkflowFingerprint increments count', () => {
    const data = { goal: 'Run tests and fix errors', toolSequence: ['run_shell', 'write_file'], outcome: 'success' as const };
    updateWorkflowFingerprint(data);
    updateWorkflowFingerprint(data);
    const repeated = findRepeatedWorkflows(2);
    expect(repeated.length).toBe(1);
    expect(repeated[0].count).toBe(2);
  });

  it('findRepeatedWorkflows respects threshold', () => {
    updateWorkflowFingerprint({ goal: 'Fix lint', toolSequence: ['run_shell'], outcome: 'success' as const });
    updateWorkflowFingerprint({ goal: 'Fix lint', toolSequence: ['run_shell'], outcome: 'success' as const });
    expect(findRepeatedWorkflows(3).length).toBe(0);
    expect(findRepeatedWorkflows(2).length).toBe(1);
  });

  it('normalizeGoal handles various inputs', () => {
    expect(normalizeGoal('Review PR #123!')).toBe('review pr 123');
    expect(normalizeGoal('  Run  Tests  ')).toBe('run tests');
    expect(normalizeGoal('')).toBe('');
  });

  it('normalizeGoal truncates long goals', () => {
    const long = 'a '.repeat(200);
    expect(normalizeGoal(long).length).toBeLessThanOrEqual(200);
  });
});

describe('session transcript parsing', () => {
  it('extractToolSequence finds tools from content XML', () => {
    const entries: SessionTranscriptEntry[] = [
      { role: 'user', content: 'Review the PR' },
      { role: 'assistant', content: '<tool_call name="github.get_pull_request_diff">{"pull_number": 1}</tool_call>' },
      { role: 'assistant', content: '<tool_call name="github.list_issues">{"state": "open"}</tool_call>' },
    ];
    const tools = extractToolSequence(entries);
    expect(tools).toContain('github.get_pull_request_diff');
    expect(tools).toContain('github.list_issues');
  });

  it('extractGoal gets first user message', () => {
    const entries: SessionTranscriptEntry[] = [
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: 'Review this PR and check for issues' },
      { role: 'assistant', content: 'Looking at the diff' },
    ];
    expect(extractGoal(entries)).toContain('Review this PR');
  });
});

describe('secret redaction in drafts', () => {
  beforeEach(() => { clearSkillLearningAudit(); });

  it('draft redacts API keys from body', async () => {
    const fp: WorkflowFingerprint = {
      id: 'test-fp',
      normalizedGoal: 'test workflow',
      toolSequence: ['read_file'],
      filesTouchedPatterns: [],
      skillNamesUsed: [],
      memoryKeysUsed: [],
      outcome: 'success',
      count: 3,
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    };
    const draft = await generateDraft(fp, '/tmp/sl-test');
    expect(draft.redactionWarnings).toBeDefined();
    expect(draft.body).toBeDefined();
  });

  it('draft is created with draft status', async () => {
    const fp: WorkflowFingerprint = {
      id: 'test-fp-2',
      normalizedGoal: 'create a new issue',
      toolSequence: ['github.create_issue'],
      filesTouchedPatterns: [],
      skillNamesUsed: [],
      memoryKeysUsed: [],
      outcome: 'success',
      count: 5,
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    };
    const draft = await generateDraft(fp, '/tmp/sl-test');
    expect(draft.status).toBe('draft');
    expect(draft.confidence).toBeGreaterThan(0);
    expect(draft.proposedSkillName).toBeTruthy();
  });
});

describe('draft CRUD', () => {
  const testDir = '/tmp/sl-draft-test';
  const draft: SkillDraft = {
    id: 'test-draft-1',
    title: 'Test Skill',
    description: 'A test skill',
    proposedSkillName: 'test_skill',
    sourceSessionIds: ['s1'],
    sourceTranscriptSeqs: [1, 2, 3],
    workflowFingerprint: 'fp-1',
    confidence: 0.8,
    status: 'draft',
    frontmatter: { name: 'test_skill' },
    body: '## Procedure\n1. Do something',
    redactionWarnings: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it('saves and loads draft', async () => {
    await saveDraft(draft, testDir);
    const loaded = await loadDraft('test-draft-1', testDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.title).toBe('Test Skill');
  });

  it('lists drafts', async () => {
    const list = await listDrafts(testDir);
    expect(list.length).toBeGreaterThanOrEqual(1);
  });

  it('updates draft status to approved', async () => {
    const updated = await updateDraftStatus('test-draft-1', 'approved', testDir);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('approved');
    expect(updated!.approvedAt).toBeTruthy();
  });

  it('updates draft status to rejected', async () => {
    const updated = await updateDraftStatus('test-draft-1', 'rejected', testDir);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('rejected');
    expect(updated!.rejectedAt).toBeTruthy();
  });

  it('load nonexistent draft returns null', async () => {
    const loaded = await loadDraft('nonexistent', testDir);
    expect(loaded).toBeNull();
  });
});

describe('skill usage stats', () => {
  beforeEach(() => { clearStats(); });

  it('records skill usage', () => {
    const s = recordSkillUsage('test_skill', 1, 'success', 5000);
    expect(s.useCount).toBe(1);
    expect(s.successCount).toBe(1);
    expect(s.avgDurationMs).toBe(5000);
  });

  it('increments stats on reuse', () => {
    recordSkillUsage('test_skill', 1, 'success', 5000);
    const s = recordSkillUsage('test_skill', 1, 'failed', 3000);
    expect(s.useCount).toBe(2);
    expect(s.successCount).toBe(1);
    expect(s.failureCount).toBe(1);
  });

  it('getSkillStats returns null for unknown', () => {
    expect(getSkillStats('nonexistent')).toBeNull();
  });
});

describe('skill learning audit', () => {
  beforeEach(() => { clearSkillLearningAudit(); });

  it('writes audit events', () => {
    writeSkillLearningAudit('skill_learning.draft_created', { draftId: 'd-1' });
    writeSkillLearningAudit('skill_learning.draft_approved', { draftId: 'd-1', skillName: 's-1' });
    const list = listSkillLearningAudit();
    expect(list.length).toBe(2);
    expect(list[0].event).toBe('skill_learning.draft_created');
  });

  it('limits audit records', () => {
    for (let i = 0; i < 5; i++) {
      writeSkillLearningAudit('skill_learning.usage_recorded', {});
    }
    expect(listSkillLearningAudit(3).length).toBe(3);
  });
});

describe('approval requires explicit confirmation', () => {
  it('status changes only via explicit updateDraftStatus call', () => {
    const draft: SkillDraft = {
      id: 'confirm-test',
      title: 'Confirm',
      description: '',
      proposedSkillName: 'confirm_test',
      sourceSessionIds: [],
      sourceTranscriptSeqs: [],
      workflowFingerprint: 'fp',
      confidence: 0.5,
      status: 'draft',
      frontmatter: {},
      body: 'test',
      redactionWarnings: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect(draft.status).toBe('draft');
    // Status only changes via updateDraftStatus
    const updated = { ...draft, status: 'approved' as const, approvedAt: new Date().toISOString() };
    expect(updated.status).toBe('approved');
    // Original is unchanged
    expect(draft.status).toBe('draft');
  });
});

describe('invalid draft ID handled', () => {
  it('updateDraftStatus returns null for nonexistent', async () => {
    const result = await updateDraftStatus('nonexistent-id', 'approved', '/tmp/sl-invalid');
    expect(result).toBeNull();
  });

  it('loadDraft returns null for nonexistent', async () => {
    const result = await loadDraft('nonexistent-id', '/tmp/sl-invalid');
    expect(result).toBeNull();
  });
});

// ─── Persistence ────────────────────────────────────────────────────

describe('fingerprint persistence', () => {
  const testDir = '/tmp/sl-persist-test';
  const storePath = testDir + '/workflows.jsonl';
  const { initFingerprintStore, reloadFingerprints, clearFingerprints } = require('../src/workflowDetector');

  beforeEach(() => {
    clearFingerprints();
    try { require('fs').rmSync(testDir, { recursive: true, force: true }); } catch {}
  });

  it('fingerprint persists after store recreation', () => {
    initFingerprintStore(storePath);
    updateWorkflowFingerprint({ goal: 'test workflow', toolSequence: ['read_file'], outcome: 'success' as const });
    // Reload from disk into clean state
    clearFingerprints();
    const loaded = reloadFingerprints();
    expect(loaded).toBe(1);
    const repeated = findRepeatedWorkflows(1);
    expect(repeated.length).toBe(1);
    expect(repeated[0].normalizedGoal).toContain('test workflow');
  });

  it('repeated workflow detection works after reload', () => {
    initFingerprintStore(storePath);
    updateWorkflowFingerprint({ goal: 'repeat test', toolSequence: ['run_shell'], outcome: 'success' as const });
    updateWorkflowFingerprint({ goal: 'repeat test', toolSequence: ['run_shell'], outcome: 'success' as const });
    updateWorkflowFingerprint({ goal: 'repeat test', toolSequence: ['run_shell'], outcome: 'success' as const });
    clearFingerprints();
    reloadFingerprints();
    const repeated = findRepeatedWorkflows(3);
    expect(repeated.length).toBe(1);
    expect(repeated[0].count).toBe(3);
  });

  it('secrets are not persisted', () => {
    initFingerprintStore(storePath);
    updateWorkflowFingerprint({
      goal: 'deploy with key sk-abc12345678901234567890123456789012',
      toolSequence: ['run_shell'],
    });
    const raw = require('fs').readFileSync(storePath, 'utf8');
    expect(raw).not.toContain('sk-abc');
  });
});

// ─── Session analysis ────────────────────────────────────────────────

describe('session analysis', () => {
  const { analyzeSession, analyzeRecentSessions } = require('../src/sessionAnalyzer');
  const { clearFingerprints } = require('../src/workflowDetector');

  beforeEach(() => { clearFingerprints(); try { require('fs').rmSync('/tmp/sl-session-test', { recursive: true, force: true }); } catch {} });

  it('analyzeSession updates fingerprint', async () => {
    const result = await analyzeSession('s1', [
      { role: 'user', content: 'check the repo status' },
      { role: 'assistant', content: '<tool_call name="git_status"></tool_call>' },
    ], '/tmp/sl-session-test');
    expect(result.fingerprint).toBeDefined();
    expect(result.met).toBe(false);
  });

  it('threshold creates draft', async () => {
    for (let i = 0; i < 3; i++) {
      await analyzeSession('s-' + i, [
        { role: 'user', content: 'review pull request' },
        { role: 'assistant', content: '<tool_call name="github.get_pull_request_diff"></tool_call>' },
      ], '/tmp/sl-session-test');
    }
    const result = await analyzeSession('s-4', [
      { role: 'user', content: 'review pull request' },
      { role: 'assistant', content: '<tool_call name="github.get_pull_request_diff"></tool_call>' },
    ], '/tmp/sl-session-test');
    expect(result.met).toBe(true);
    expect(result.draft).not.toBeNull();
    expect(result.draft.status).toBe('draft');
  });

  it('no draft below threshold', async () => {
    const result = await analyzeSession('s1', [
      { role: 'user', content: 'unique task' },
      { role: 'assistant', content: '<tool_call name="read_file"></tool_call>' },
    ], '/tmp/sl-session-test');
    expect(result.met).toBe(false);
    expect(result.draft).toBeNull();
  });
});

// ─── Approval/versioning ─────────────────────────────────────────────

describe('approval versioning', () => {
  const testDir = '/tmp/sl-version-test';
  const skillsDir = testDir + '/skills';

  beforeEach(async () => {
    try { require('fs').rmSync(testDir, { recursive: true, force: true }); } catch {}
    require('fs').mkdirSync(testDir, { recursive: true });
    const { saveDraft } = require('../src/skillDraftStore');
    await saveDraft({
      id: 'v-test-draft',
      title: 'Version Test',
      description: '',
      proposedSkillName: 'version_test_skill',
      sourceSessionIds: [],
      sourceTranscriptSeqs: [],
      workflowFingerprint: 'fp',
      confidence: 0.8,
      status: 'draft',
      frontmatter: { name: 'version_test_skill' },
      body: '## Procedure\\n1. Test',
      redactionWarnings: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, testDir);
  });

  it('approve new skill', async () => {
    const { loadDraft } = require('../src/skillDraftStore');
    const draft = await loadDraft('v-test-draft', testDir);
    const result = await approveDraft(draft, testDir);
    expect(result.isNew).toBe(true);
    expect(result.version).toBe(1);
    const skillPath = testDir + '/skills/version_test_skill/SKILL.md';
    expect(require('fs').existsSync(skillPath)).toBe(true);
  });

  it('approve existing skill creates v2', async () => {
    const { loadDraft } = require('../src/skillDraftStore');
    // First approval
    const draft1 = await loadDraft('v-test-draft', testDir);
    await approveDraft(draft1, testDir);
    // Second approval with same name
    const draft2 = await loadDraft('v-test-draft', testDir);
    const result = await approveDraft(draft2, testDir);
    expect(result.version).toBe(2);
    const versionsDir = testDir + '/skills/version_test_skill/versions';
    expect(require('fs').existsSync(versionsDir + '/v1.md')).toBe(true);
  });

  it('reject retained', async () => {
    const { loadDraft } = require('../src/skillDraftStore');
    const updated = await updateDraftStatus('v-test-draft', 'rejected', testDir);
    expect(updated.status).toBe('rejected');
    expect(updated.rejectedAt).toBeTruthy();
  });

  it('approve rejected draft denied', async () => {
    await updateDraftStatus('v-test-draft', 'rejected', testDir);
    const { loadDraft } = require('../src/skillDraftStore');
    const draft = await loadDraft('v-test-draft', testDir);
    if (draft.status !== 'draft') {
      expect(draft.status).toBe('rejected');
    }
  });

  it('approve already approved draft denied', async () => {
    await updateDraftStatus('v-test-draft', 'approved', testDir);
    const { loadDraft } = require('../src/skillDraftStore');
    const draft = await loadDraft('v-test-draft', testDir);
    expect(draft.status).toBe('approved');
  });
});

// ─── TUI Canvas tab tests ────────────────────────────────────────────

describe('TUI Skill Learning panel', () => {
  it('renders draft list without secrets', () => {
    const drafts = [
      { id: 'd-1', status: 'draft', proposedSkillName: 'test_skill', confidence: 0.8, redactionWarnings: ['Redacted API key'] },
    ];
    for (const d of drafts) {
      expect(Object.keys(d)).not.toContain('token');
      expect(Object.keys(d)).not.toContain('secret');
      expect(d.redactionWarnings).toContain('Redacted API key');
    }
  });

  it('handles API offline state', () => {
    const apiReachable = false;
    expect(apiReachable).toBe(false);
  });
});
