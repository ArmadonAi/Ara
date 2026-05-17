import { z } from 'zod';

// Validate GitHub config
export function validateGitHubConfig(raw: unknown): { ok: boolean; data?: any; error?: string } {
  const { GitHubConfigSchema } = require('./types');
  const result = GitHubConfigSchema.safeParse(raw);
  if (!result.success) {
    return { ok: false, error: result.error.message };
  }
  return { ok: true, data: result.data };
}

// Zod schemas for GitHub tool inputs

export const GetRepoSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
});

export const ListIssuesSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  state: z.enum(['open', 'closed', 'all']).optional().default('open'),
  per_page: z.number().int().min(1).max(100).optional().default(30),
  page: z.number().int().min(1).optional().default(1),
});

export const GetIssueSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  issue_number: z.number().int().positive(),
});

export const CreateIssueSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  title: z.string().min(1),
  body: z.string().optional(),
  labels: z.array(z.string()).optional(),
});

export const CommentIssueSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  issue_number: z.number().int().positive(),
  body: z.string().min(1),
});

export const ListPullRequestsSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  state: z.enum(['open', 'closed', 'all']).optional().default('open'),
  per_page: z.number().int().min(1).max(100).optional().default(30),
  page: z.number().int().min(1).optional().default(1),
});

export const GetPullRequestSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  pull_number: z.number().int().positive(),
});

export const GetPullRequestFilesSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  pull_number: z.number().int().positive(),
});

export const GetPullRequestDiffSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  pull_number: z.number().int().positive(),
});

export const CreatePullRequestReviewSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  pull_number: z.number().int().positive(),
  body: z.string().min(1),
  event: z.enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']).default('COMMENT'),
});

export const ListCheckRunsSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  ref: z.string().min(1),
  per_page: z.number().int().min(1).max(100).optional().default(30),
  page: z.number().int().min(1).optional().default(1),
});

export const ListWorkflowRunsSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  per_page: z.number().int().min(1).max(100).optional().default(30),
  page: z.number().int().min(1).optional().default(1),
});

export const GetWorkflowRunSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  run_id: z.number().int().positive(),
});
