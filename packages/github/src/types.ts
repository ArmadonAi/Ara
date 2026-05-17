import { z } from 'zod';

// --- GitHub config ---
export const GitHubConfigSchema = z.object({
  enabled: z.boolean().default(true),
  defaultOwner: z.string().optional(),
  defaultRepo: z.string().optional(),
  apiBaseUrl: z.string().url().default('https://api.github.com'),
  tokenEnv: z.string().default('GITHUB_TOKEN'),
  permissionMode: z.enum(['plan', 'default', 'accept-edits', 'auto-safe', 'danger-review']).default('default'),
  allowedRepos: z.array(z.string()).default([]),
  readOnly: z.boolean().default(false),
});
export type GitHubConfig = z.infer<typeof GitHubConfigSchema>;

// --- GitHub tool types ---
export type GitHubToolName =
  | 'github.get_repo'
  | 'github.list_issues'
  | 'github.get_issue'
  | 'github.create_issue'
  | 'github.comment_issue'
  | 'github.list_pull_requests'
  | 'github.get_pull_request'
  | 'github.get_pull_request_files'
  | 'github.get_pull_request_diff'
  | 'github.create_pull_request_review'
  | 'github.list_check_runs'
  | 'github.list_workflow_runs'
  | 'github.get_workflow_run';

// --- GitHub audit ---
export interface GitHubAuditRecord {
  id: string;
  sessionId: string;
  toolName: string;
  owner: string;
  repo: string;
  resourceType: 'repo' | 'issue' | 'pull_request' | 'check' | 'workflow';
  resourceId?: string | number;
  inputSummary?: string;
  outputSummary?: string;
  status: 'success' | 'failed';
  dangerLevel: 'safe' | 'write' | 'network' | 'dangerous';
  permissionDecision?: string;
  approvalId?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  error?: string;
}

// --- GitHub health ---
export interface GitHubHealthStatus {
  configured: boolean;
  tokenPresent: boolean;
  tokenEnv: string;
  defaultOwner?: string;
  defaultRepo?: string;
  apiReachable?: boolean;
  rateLimitRemaining?: number;
  readOnly: boolean;
  allowedRepos: string[];
  permissionMode: string;
}

// --- GitHub permission ---
export interface GitHubPermissionInput {
  toolName: GitHubToolName;
  owner: string;
  repo: string;
  sessionId?: string;
  permissionMode: string;
  readOnly: boolean;
  allowedRepos: string[];
  isSubagent?: boolean;
  tokenPresent: boolean;
}

export interface GitHubPermissionOutput {
  decision: 'allow' | 'ask' | 'deny';
  reason: string;
  requiresApproval: boolean;
}
