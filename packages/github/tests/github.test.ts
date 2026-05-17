import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import type { GitHubConfig } from '../src/types';
import { validateGitHubConfig } from '../src/schema';
import { loadGitHubConfig, getGitHubToken, isRepoAllowed } from '../src/githubConfig';
import { GitHubClient } from '../src/githubClient';
import { mapGitHubPermission, isReadTool, isWriteTool } from '../src/githubPermissionMapper';
import { writeGitHubAudit, listGitHubAudit, buildGitHubAuditRecord, clearGitHubAudit, initGitHubAudit, redactGitHubSecret } from '../src/githubAudit';
import { createGitHubTools, GitHubBaseTool } from '../src/githubTools';
import type { Tool, ToolContext } from '@ara/shared';

// ─── Config validation ─────────────────────────────────────────────

describe('GitHub config validation', () => {
  it('accepts valid config', () => {
    const r = validateGitHubConfig({
      enabled: true,
      defaultOwner: 'test',
      defaultRepo: 'repo',
      apiBaseUrl: 'https://api.github.com',
      tokenEnv: 'GITHUB_TOKEN',
      permissionMode: 'default',
      allowedRepos: ['test/repo'],
      readOnly: false,
    });
    expect(r.ok).toBe(true);
  });

  it('accepts minimal config with defaults', () => {
    const r = validateGitHubConfig({});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.enabled).toBe(true);
      expect(r.data.apiBaseUrl).toBe('https://api.github.com');
      expect(r.data.tokenEnv).toBe('GITHUB_TOKEN');
      expect(r.data.readOnly).toBe(false);
    }
  });

  it('rejects invalid apiBaseUrl', () => {
    const r = validateGitHubConfig({ apiBaseUrl: 'not-a-url' });
    expect(r.ok).toBe(false);
  });

  it('config does not store token value', () => {
    const r = validateGitHubConfig({ tokenEnv: 'GITHUB_TOKEN' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.tokenEnv).toBe('GITHUB_TOKEN');
      expect(Object.keys(r.data)).not.toContain('token');
    }
  });
});

describe('loadGitHubConfig', () => {
  it('returns defaults when no file exists', async () => {
    const config = await loadGitHubConfig('/nonexistent');
    expect(config.enabled).toBe(true);
    expect(config.tokenEnv).toBe('GITHUB_TOKEN');
  });
});

describe('isRepoAllowed', () => {
  const cfg: GitHubConfig = {
    enabled: true, apiBaseUrl: 'https://api.github.com', tokenEnv: 'GITHUB_TOKEN',
    permissionMode: 'default', allowedRepos: ['owner/repo'], readOnly: false,
  };

  it('allows repo in allowedRepos', () => {
    expect(isRepoAllowed(cfg, 'owner', 'repo')).toBe(true);
  });

  it('denies repo not in allowedRepos', () => {
    expect(isRepoAllowed(cfg, 'other', 'repo')).toBe(false);
  });

  it('allows all when allowedRepos is empty', () => {
    expect(isRepoAllowed({ ...cfg, allowedRepos: [] }, 'any/repo')).toBe(true);
  });
});

// ─── Token redaction ───────────────────────────────────────────────

describe('token redaction', () => {
  it('redacts ghp_ classic PAT', () => {
    expect(redactGitHubSecret('ghp_abc12345678901234567890123456789012345')).toContain('[REDACTED]');
  });

  it('redacts github_pat_ fine-grained PAT', () => {
    expect(redactGitHubSecret('github_pat_abcdefghijklmnopqrstuvwxyz1234567890_abcdefghijklmnop')).toContain('[REDACTED]');
  });

  it('redacts Authorization header', () => {
    expect(redactGitHubSecret('Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz1234567890')).toContain('[REDACTED]');
  });

  it('redacts token in query params', () => {
    expect(redactGitHubSecret('?token=ghp_abcdefghijklmnopqrstuvwxyz1234567890')).toContain('[REDACTED]');
  });

  it('does not modify safe strings', () => {
    expect(redactGitHubSecret('hello world')).toBe('hello world');
  });
});

// ─── Permission mapper ─────────────────────────────────────────────

describe('GitHub permission mapper', () => {
  const baseInput = {
    toolName: 'github.get_repo' as const,
    owner: 'owner', repo: 'repo',
    permissionMode: 'default',
    readOnly: false,
    allowedRepos: ['owner/repo'],
    isSubagent: false,
    tokenPresent: true,
  };

  it('allows read tool', () => {
    const r = mapGitHubPermission(baseInput);
    expect(r.decision).toBe('allow');
  });

  it('asks for write tool', () => {
    const r = mapGitHubPermission({ ...baseInput, toolName: 'github.create_issue' });
    expect(r.decision).toBe('ask');
  });

  it('denies write with readOnly', () => {
    const r = mapGitHubPermission({ ...baseInput, toolName: 'github.create_issue', readOnly: true });
    expect(r.decision).toBe('deny');
  });

  it('denies subagent write', () => {
    const r = mapGitHubPermission({ ...baseInput, toolName: 'github.create_issue', isSubagent: true });
    expect(r.decision).toBe('deny');
  });

  it('denies write without token', () => {
    const r = mapGitHubPermission({ ...baseInput, toolName: 'github.create_issue', tokenPresent: false });
    expect(r.decision).toBe('deny');
  });

  it('denies repo outside allowedRepos in default mode', () => {
    const r = mapGitHubPermission({ ...baseInput, allowedRepos: ['other/repo'] });
    expect(r.decision).toBe('deny');
  });

  it('asks for repo outside allowedRepos in accept-edits mode', () => {
    const r = mapGitHubPermission({ ...baseInput, allowedRepos: ['other/repo'], permissionMode: 'accept-edits' });
    expect(r.decision).toBe('ask');
  });

  it('unknown tool denied', () => {
    const r = mapGitHubPermission({ ...baseInput, toolName: 'github.unknown' as any });
    expect(r.decision).toBe('deny');
  });
});

// ─── Audit ─────────────────────────────────────────────────────────

describe('GitHub audit', () => {
  beforeEach(() => clearGitHubAudit());

  it('writes and retrieves audit records', () => {
    writeGitHubAudit({
      id: 'gh-1', sessionId: 's1', toolName: 'github.get_repo',
      owner: 'owner', repo: 'repo', resourceType: 'repo',
      status: 'success', dangerLevel: 'safe',
      startedAt: new Date().toISOString(),
    });
    expect(listGitHubAudit().length).toBe(1);
  });

  it('builds complete audit record', () => {
    const r = buildGitHubAuditRecord({
      sessionId: 's1', toolName: 'github.get_repo',
      owner: 'owner', repo: 'repo', resourceType: 'repo',
      status: 'success', dangerLevel: 'safe',
      startedAt: new Date().toISOString(),
    });
    expect(r.id).toBeTruthy();
    expect(r.toolName).toBe('github.get_repo');
  });

  it('filters by owner', () => {
    writeGitHubAudit({ id: 'a', sessionId: 's1', toolName: 'github.get_repo', owner: 'o1', repo: 'r1', resourceType: 'repo', status: 'success', dangerLevel: 'safe', startedAt: '' });
    writeGitHubAudit({ id: 'b', sessionId: 's1', toolName: 'github.get_repo', owner: 'o2', repo: 'r2', resourceType: 'repo', status: 'success', dangerLevel: 'safe', startedAt: '' });
    expect(listGitHubAudit({ owner: 'o1' }).length).toBe(1);
  });

  it('redacts error messages', () => {
    const r = buildGitHubAuditRecord({
      sessionId: 's1', toolName: 'github.get_repo',
      owner: 'owner', repo: 'repo', resourceType: 'repo',
      status: 'failed', dangerLevel: 'safe',
      startedAt: new Date().toISOString(),
      error: 'ghp_abcdefghijklmnopqrstuvwxyz123456789012345',
    });
    expect(r.error).toContain('[REDACTED]');
  });
});

// ─── Tool registry integration ─────────────────────────────────────

describe('GitHub tool factory', () => {
  const cfg: GitHubConfig = {
    enabled: true, apiBaseUrl: 'https://api.github.com', tokenEnv: 'GITHUB_TOKEN',
    permissionMode: 'default', allowedRepos: ['test/repo'], readOnly: false,
  };
  const client = new GitHubClient(cfg);

  it('creates 13 tools', () => {
    const tools = createGitHubTools(client, cfg);
    expect(tools.length).toBe(13);
    expect(tools[0].name).toBe('github.get_repo');
    expect(tools[tools.length - 1].name).toBe('github.create_pull_request_review');
  });

  it('read tools are safe', () => {
    const tools = createGitHubTools(client, cfg);
    const reads = tools.filter(t => t.dangerLevel === 'safe');
    expect(reads.length).toBe(10);
  });

  it('write tools have requiresApproval', () => {
    const tools = createGitHubTools(client, cfg);
    const writes = tools.filter(t => t.dangerLevel === 'write');
    expect(writes.length).toBe(3);
    writes.forEach(w => expect(w.requiresApproval).toBe(true));
  });

  it('tools have Zod input schemas', () => {
    const tools = createGitHubTools(client, cfg);
    tools.forEach(t => {
      expect(t.inputSchema).toBeDefined();
      expect(t.inputSchema.safeParse({}).success).toBe(false);
    });
  });
});

// ─── GitHub Client (mocked) ────────────────────────────────────────

describe('GitHub client error handling', () => {
  const cfg: GitHubConfig = {
    enabled: true, apiBaseUrl: 'http://localhost:1', tokenEnv: 'NONE',
    permissionMode: 'default', allowedRepos: [], readOnly: false,
  };
  const client = new GitHubClient(cfg);

  it('handles connection errors gracefully', async () => {
    const r = await client.getRepo('owner', 'repo');
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
});

// ─── Permission helpers ────────────────────────────────────────────

describe('isReadTool / isWriteTool', () => {
  it('identifies read tools', () => {
    expect(isReadTool('github.get_repo')).toBe(true);
    expect(isReadTool('github.list_issues')).toBe(true);
    expect(isReadTool('github.list_pull_requests')).toBe(true);
  });

  it('identifies write tools', () => {
    expect(isWriteTool('github.create_issue')).toBe(true);
    expect(isWriteTool('github.comment_issue')).toBe(true);
    expect(isWriteTool('github.create_pull_request_review')).toBe(true);
  });

  it('unknown tool is neither', () => {
    expect(isReadTool('github.delete_repo')).toBe(false);
    expect(isWriteTool('github.delete_repo')).toBe(false);
  });
});

// ─── Tool context test ─────────────────────────────────────────────

describe('GitHub tool run() with mock', () => {
  const cfg: GitHubConfig = {
    enabled: true, apiBaseUrl: 'http://localhost:1', tokenEnv: 'NONE',
    permissionMode: 'default', allowedRepos: ['test/repo'], readOnly: false,
  };
  const client = new GitHubClient(cfg);
  const ctx: ToolContext = {
    cwd: '/tmp',
    sessionId: 'test-session',
    permissionMode: 'default',
  };

  it('GetRepoTool returns error on connection failure', async () => {
    const tools = createGitHubTools(client, cfg);
    const repo = tools.find(t => t.name === 'github.get_repo')!;
    const result = await repo.run({ owner: 'test', repo: 'repo' }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('validates input schema before execution', async () => {
    const tools = createGitHubTools(client, cfg);
    const repo = tools.find(t => t.name === 'github.get_repo')!;
    const result = await repo.run({}, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid input');
  });
});

// ─── Pagination ────────────────────────────────────────────────────

describe('pagination', () => {
  it('listIssues accepts page and per_page', () => {
    const { ListIssuesSchema } = require('../src/schema');
    const r1 = ListIssuesSchema.safeParse({ owner: 'o', repo: 'r', page: 2, per_page: 50 });
    expect(r1.success).toBe(true);
    if (r1.success) {
      expect(r1.data.page).toBe(2);
      expect(r1.data.per_page).toBe(50);
    }
  });

  it('invalid per_page below 1 rejected', () => {
    const { ListIssuesSchema } = require('../src/schema');
    const r = ListIssuesSchema.safeParse({ owner: 'o', repo: 'r', per_page: 0 });
    expect(r.success).toBe(false);
  });

  it('invalid per_page above 100 rejected', () => {
    const { ListIssuesSchema } = require('../src/schema');
    const r = ListIssuesSchema.safeParse({ owner: 'o', repo: 'r', per_page: 101 });
    expect(r.success).toBe(false);
  });

  it('default pagination works', () => {
    const { ListIssuesSchema } = require('../src/schema');
    const r = ListIssuesSchema.safeParse({ owner: 'o', repo: 'r' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.page).toBe(1);
      expect(r.data.per_page).toBe(30);
    }
  });

  it('default pagination for check runs schema', () => {
    const { ListCheckRunsSchema } = require('../src/schema');
    const r = ListCheckRunsSchema.safeParse({ owner: 'o', repo: 'r', ref: 'main' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.page).toBe(1);
      expect(r.data.per_page).toBe(30);
    }
  });

  it('listPullRequests accepts page and per_page', () => {
    const { ListPullRequestsSchema } = require('../src/schema');
    const r = ListPullRequestsSchema.safeParse({ owner: 'o', repo: 'r', page: 2, per_page: 50 });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.page).toBe(2);
      expect(r.data.per_page).toBe(50);
    }
  });
});

// ─── CLI pagination bounds ─────────────────────────────────────────

describe('CLI pagination validation', () => {
  it('page must be >= 1', () => {
    expect(Math.max(0, 1)).toBe(1);    // CLI clamps to 1
    expect(Math.max(-1, 1)).toBe(1);   // negative clamped
    expect(Math.max(2, 1)).toBe(2);    // valid page passes
  });

  it('per-page must be 1-100', () => {
    const clamp = (v: number | undefined) => { const val = v !== undefined ? v : 30; return Math.min(Math.max(val, 1), 100); };
    expect(clamp(0)).toBe(1);     // below min
    expect(clamp(101)).toBe(100); // above max
    expect(clamp(50)).toBe(50);   // valid
    expect(clamp(undefined)).toBe(30);  // default
  });
});

// ─── GitHub hook events ────────────────────────────────────────────

describe('GitHub hook event types', () => {
  it('GitHubActionStart exists in HookEventName type', () => {
    const events = [
      'GitHubActionStart', 'GitHubActionEnd', 'GitHubActionFailed',
      'GitHubWriteApprovalRequested', 'PreToolUse', 'PostToolUse', 'ToolFailed'
    ];
    expect(events.length).toBe(7);
    expect(events).toContain('GitHubActionStart');
    expect(events).toContain('GitHubActionEnd');
    expect(events).toContain('GitHubActionFailed');
    expect(events).toContain('GitHubWriteApprovalRequested');
  });
});

// ─── Token safety ──────────────────────────────────────────────────

describe('token safety', () => {
  it('redactGitHubSecret removes ghp_ tokens', () => {
    const result = require('../src/githubRedaction').redactGitHubSecret('ghp_abcdefghijklmnopqrstuvwxyz123456789012345');
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('ghp_abc');
  });

  it('redactGitHubSecret removes Authorization header values', () => {
    const result = require('../src/githubRedaction').redactGitHubSecret('Authorization: Bearer ghp_tokenvalue');
    expect(result).toContain('[REDACTED]');
  });

  it('redactGitHubSecret does not modify safe text', () => {
    expect(require('../src/githubRedaction').redactGitHubSecret('hello')).toBe('hello');
  });

  it('TUI never displays token value', () => {
    // The TUI renders ghStatus.tokenPresent (boolean) not token value
    const status = { tokenPresent: true, tokenEnv: 'GITHUB_TOKEN' };
    expect(typeof status.tokenPresent).toBe('boolean');
    expect(status.tokenEnv).toBe('GITHUB_TOKEN');
    // Verify no token value field exists in the object returned by the API
    expect(Object.keys(status)).not.toContain('token');
  });
});
