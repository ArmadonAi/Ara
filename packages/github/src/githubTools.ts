import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from '@ara/shared';
import { GitHubClient } from './githubClient';
import type { GitHubConfig } from './types';
import { mapGitHubPermission } from './githubPermissionMapper';
import { buildGitHubAuditRecord, writeGitHubAudit, redactGitHubSecret } from './githubAudit';
import { runHooks, createHookEventPayload } from '@ara/hooks';

// ── Base class for GitHub tools ────────────────────────────────────

export abstract class GitHubBaseTool implements Tool {
  abstract name: string;
  abstract description: string;
  abstract dangerLevel: 'safe' | 'write' | 'network' | 'dangerous';
  abstract requiresApproval: boolean;
  abstract inputSchema: z.ZodSchema<any>;
  abstract resourceType: 'repo' | 'issue' | 'pull_request' | 'check' | 'workflow';

  protected client: GitHubClient;
  protected config: GitHubConfig;

  constructor(client: GitHubClient, config: GitHubConfig) {
    this.client = client;
    this.config = config;
  }

  abstract execute(input: any): Promise<{ ok: boolean; data?: any; error?: string }>;

  async run(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const parsed = this.inputSchema.safeParse(input);

    if (!parsed.success) {
      return { success: false, output: '', error: `Invalid input: ${parsed.error.message}` };
    }

    const params = parsed.data;
    const owner = params.owner || this.config.defaultOwner || '';
    const repo = params.repo || this.config.defaultRepo || '';

    try {
      // Permission check
      const permResult = mapGitHubPermission({
        toolName: this.name as any,
        owner,
        repo,
        sessionId: ctx.sessionId,
        permissionMode: this.config.permissionMode,
        readOnly: this.config.readOnly,
        allowedRepos: this.config.allowedRepos,
        isSubagent: ctx.sessionId?.startsWith('sub-') || false,
        tokenPresent: this.client.getTokenPresent(),
      });

      if (permResult.decision === 'deny') {
        writeGitHubAudit(buildGitHubAuditRecord({
          sessionId: ctx.sessionId,
          toolName: this.name,
          owner, repo,
          resourceType: this.resourceType,
          resourceId: params.issue_number || params.pull_number || params.run_id,
          status: 'failed',
          dangerLevel: this.dangerLevel,
          permissionDecision: 'deny',
          startedAt,
          durationMs: Date.now() - t0,
          error: permResult.reason,
        }));
        runHooks('GitHubActionFailed', createHookEventPayload('GitHubActionFailed', ctx.sessionId, ctx.permissionMode, {
          toolName: this.name, owner, repo, reason: permResult.reason,
        })).catch(() => {});
        return { success: false, output: '', error: `[GITHUB BLOCKED] ${permResult.reason}` };
      }

      if (permResult.decision === 'ask' && this.requiresApproval) {
        runHooks('GitHubWriteApprovalRequested', createHookEventPayload('GitHubWriteApprovalRequested', ctx.sessionId, ctx.permissionMode, {
          toolName: this.name, owner, repo, resourceType: this.resourceType,
        })).catch(() => {});
        return {
          success: false,
          output: '',
          error: `[GITHUB AWAITING APPROVAL] ${this.name} — ${permResult.reason}`,
        };
      }

      // Fire GitHubActionStart hook
      runHooks('GitHubActionStart', createHookEventPayload('GitHubActionStart', ctx.sessionId, ctx.permissionMode, {
        toolName: this.name, owner, repo, resourceType: this.resourceType,
        input: redactGitHubSecret(JSON.stringify(params)),
      })).catch(() => {});

      const result = await this.execute(params);

      if (result.ok) {
        runHooks('GitHubActionEnd', createHookEventPayload('GitHubActionEnd', ctx.sessionId, ctx.permissionMode, {
          toolName: this.name, owner, repo, status: 'success',
        })).catch(() => {});
      } else {
        runHooks('GitHubActionFailed', createHookEventPayload('GitHubActionFailed', ctx.sessionId, ctx.permissionMode, {
          toolName: this.name, owner, repo, reason: redactGitHubSecret(result.error || 'GitHub API error'),
        })).catch(() => {});
      }

      writeGitHubAudit(buildGitHubAuditRecord({
        sessionId: ctx.sessionId,
        toolName: this.name,
        owner, repo,
        resourceType: this.resourceType,
        resourceId: params.issue_number || params.pull_number || params.run_id,
        input: params,
        output: result.data,
        status: result.ok ? 'success' : 'failed',
        dangerLevel: this.dangerLevel,
        permissionDecision: permResult.decision,
        startedAt,
        durationMs: Date.now() - t0,
        error: result.error,
      }));

      if (!result.ok) {
        return { success: false, output: '', error: result.error };
      }

      const outputStr = typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2).slice(0, 2000);
      return { success: true, output: outputStr };
    } catch (e: any) {
      runHooks('GitHubActionFailed', createHookEventPayload('GitHubActionFailed', ctx.sessionId, ctx.permissionMode, {
        toolName: this.name, owner, repo, reason: redactGitHubSecret(e.message),
      })).catch(() => {});
      writeGitHubAudit(buildGitHubAuditRecord({
        sessionId: ctx.sessionId,
        toolName: this.name,
        owner, repo,
        resourceType: this.resourceType,
        status: 'failed',
        dangerLevel: this.dangerLevel,
        startedAt,
        durationMs: Date.now() - t0,
        error: redactGitHubSecret(e.message),
      }));
      return { success: false, output: '', error: redactGitHubSecret(e.message) };
    }
  }
}

// ── Read tools ──────────────────────────────────────────────────────

export class GetRepoTool extends GitHubBaseTool {
  name = 'github.get_repo' as const;
  description = 'Get repository details and metadata';
  dangerLevel = 'safe' as const;
  requiresApproval = false;
  inputSchema = z.object({ owner: z.string().min(1), repo: z.string().min(1) });
  resourceType = 'repo' as const;
  async execute(input: any) { return this.client.getRepo(input.owner, input.repo); }
}

export class ListIssuesTool extends GitHubBaseTool {
  name = 'github.list_issues' as const;
  description = 'List repository issues filtered by state';
  dangerLevel = 'safe' as const;
  requiresApproval = false;
  inputSchema = z.object({ owner: z.string().min(1), repo: z.string().min(1), state: z.string().optional(), per_page: z.number().min(1).max(100).optional(), page: z.number().min(1).optional() });
  resourceType = 'issue' as const;
  async execute(input: any) { return this.client.listIssues(input.owner, input.repo, input.state, input.per_page, input.page); }
}

export class GetIssueTool extends GitHubBaseTool {
  name = 'github.get_issue' as const;
  description = 'Get a specific issue by number';
  dangerLevel = 'safe' as const;
  requiresApproval = false;
  inputSchema = z.object({ owner: z.string().min(1), repo: z.string().min(1), issue_number: z.number().int().positive() });
  resourceType = 'issue' as const;
  async execute(input: any) { return this.client.getIssue(input.owner, input.repo, input.issue_number); }
}

export class ListPullRequestsTool extends GitHubBaseTool {
  name = 'github.list_pull_requests' as const;
  description = 'List pull requests for the repository';
  dangerLevel = 'safe' as const;
  requiresApproval = false;
  inputSchema = z.object({ owner: z.string().min(1), repo: z.string().min(1), state: z.string().optional(), per_page: z.number().min(1).max(100).optional(), page: z.number().min(1).optional() });
  resourceType = 'pull_request' as const;
  async execute(input: any) { return this.client.listPullRequests(input.owner, input.repo, input.state, input.per_page, input.page); }
}

export class GetPullRequestTool extends GitHubBaseTool {
  name = 'github.get_pull_request' as const;
  description = 'Get details of a specific pull request';
  dangerLevel = 'safe' as const;
  requiresApproval = false;
  inputSchema = z.object({ owner: z.string().min(1), repo: z.string().min(1), pull_number: z.number().int().positive() });
  resourceType = 'pull_request' as const;
  async execute(input: any) { return this.client.getPullRequest(input.owner, input.repo, input.pull_number); }
}

export class GetPullRequestFilesTool extends GitHubBaseTool {
  name = 'github.get_pull_request_files' as const;
  description = 'List files changed in a pull request';
  dangerLevel = 'safe' as const;
  requiresApproval = false;
  inputSchema = z.object({ owner: z.string().min(1), repo: z.string().min(1), pull_number: z.number().int().positive() });
  resourceType = 'pull_request' as const;
  async execute(input: any) { return this.client.getPullRequestFiles(input.owner, input.repo, input.pull_number); }
}

export class GetPullRequestDiffTool extends GitHubBaseTool {
  name = 'github.get_pull_request_diff' as const;
  description = 'Get the unified diff of a pull request';
  dangerLevel = 'safe' as const;
  requiresApproval = false;
  inputSchema = z.object({ owner: z.string().min(1), repo: z.string().min(1), pull_number: z.number().int().positive() });
  resourceType = 'pull_request' as const;
  async execute(input: any) { return this.client.getPullRequestDiff(input.owner, input.repo, input.pull_number); }
}

export class ListCheckRunsTool extends GitHubBaseTool {
  name = 'github.list_check_runs' as const;
  description = 'List check runs for a specific Git ref';
  dangerLevel = 'safe' as const;
  requiresApproval = false;
  inputSchema = z.object({ owner: z.string().min(1), repo: z.string().min(1), ref: z.string().min(1), per_page: z.number().min(1).max(100).optional(), page: z.number().min(1).optional() });
  resourceType = 'check' as const;
  async execute(input: any) { return this.client.listCheckRuns(input.owner, input.repo, input.ref, input.per_page, input.page); }
}

export class ListWorkflowRunsTool extends GitHubBaseTool {
  name = 'github.list_workflow_runs' as const;
  description = 'List workflow runs for the repository';
  dangerLevel = 'safe' as const;
  requiresApproval = false;
  inputSchema = z.object({ owner: z.string().min(1), repo: z.string().min(1), per_page: z.number().min(1).max(100).optional(), page: z.number().min(1).optional() });
  resourceType = 'workflow' as const;
  async execute(input: any) { return this.client.listWorkflowRuns(input.owner, input.repo, input.per_page, input.page); }
}

export class GetWorkflowRunTool extends GitHubBaseTool {
  name = 'github.get_workflow_run' as const;
  description = 'Get details of a specific workflow run';
  dangerLevel = 'safe' as const;
  requiresApproval = false;
  inputSchema = z.object({ owner: z.string().min(1), repo: z.string().min(1), run_id: z.number().int().positive() });
  resourceType = 'workflow' as const;
  async execute(input: any) { return this.client.getWorkflowRun(input.owner, input.repo, input.run_id); }
}

// ── Write tools ─────────────────────────────────────────────────────

export class CreateIssueTool extends GitHubBaseTool {
  name = 'github.create_issue' as const;
  description = 'Create a new issue on the repository';
  dangerLevel = 'write' as const;
  requiresApproval = true;
  inputSchema = z.object({ owner: z.string().min(1), repo: z.string().min(1), title: z.string().min(1), body: z.string().optional(), labels: z.array(z.string()).optional() });
  resourceType = 'issue' as const;
  async execute(input: any) { return this.client.createIssue(input.owner, input.repo, input.title, input.body, input.labels); }
}

export class CommentIssueTool extends GitHubBaseTool {
  name = 'github.comment_issue' as const;
  description = 'Comment on an existing issue';
  dangerLevel = 'write' as const;
  requiresApproval = true;
  inputSchema = z.object({ owner: z.string().min(1), repo: z.string().min(1), issue_number: z.number().int().positive(), body: z.string().min(1) });
  resourceType = 'issue' as const;
  async execute(input: any) { return this.client.commentIssue(input.owner, input.repo, input.issue_number, input.body); }
}

export class CreatePullRequestReviewTool extends GitHubBaseTool {
  name = 'github.create_pull_request_review' as const;
  description = 'Create a review on a pull request (approve, request changes, or comment)';
  dangerLevel = 'write' as const;
  requiresApproval = true;
  inputSchema = z.object({ owner: z.string().min(1), repo: z.string().min(1), pull_number: z.number().int().positive(), body: z.string().min(1), event: z.string().optional() });
  resourceType = 'pull_request' as const;
  async execute(input: any) { return this.client.createPullRequestReview(input.owner, input.repo, input.pull_number, input.body, input.event || 'COMMENT'); }
}

// ── Factory ─────────────────────────────────────────────────────────

export function createGitHubTools(client: GitHubClient, config: GitHubConfig): GitHubBaseTool[] {
  return [
    new GetRepoTool(client, config),
    new ListIssuesTool(client, config),
    new GetIssueTool(client, config),
    new ListPullRequestsTool(client, config),
    new GetPullRequestTool(client, config),
    new GetPullRequestFilesTool(client, config),
    new GetPullRequestDiffTool(client, config),
    new ListCheckRunsTool(client, config),
    new ListWorkflowRunsTool(client, config),
    new GetWorkflowRunTool(client, config),
    new CreateIssueTool(client, config),
    new CommentIssueTool(client, config),
    new CreatePullRequestReviewTool(client, config),
  ];
}
