import type { GitHubPermissionInput, GitHubPermissionOutput, GitHubToolName } from './types';

const READ_TOOLS: GitHubToolName[] = [
  'github.get_repo',
  'github.list_issues',
  'github.get_issue',
  'github.list_pull_requests',
  'github.get_pull_request',
  'github.get_pull_request_files',
  'github.get_pull_request_diff',
  'github.list_check_runs',
  'github.list_workflow_runs',
  'github.get_workflow_run',
];

const WRITE_TOOLS: GitHubToolName[] = [
  'github.create_issue',
  'github.comment_issue',
  'github.create_pull_request_review',
];

export function isReadTool(toolName: string): boolean {
  return READ_TOOLS.includes(toolName as GitHubToolName);
}

export function isWriteTool(toolName: string): boolean {
  return WRITE_TOOLS.includes(toolName as GitHubToolName);
}

export function mapGitHubPermission(input: GitHubPermissionInput): GitHubPermissionOutput {
  const { toolName, owner, repo, permissionMode, readOnly, allowedRepos, isSubagent, tokenPresent } = input;
  const isWrite = isWriteTool(toolName);
  const isRead = isReadTool(toolName);

  // 1. Unknown tool → deny
  if (!isRead && !isWrite) {
    return { decision: 'deny', reason: `Unknown GitHub tool: ${toolName}`, requiresApproval: false };
  }

  // 2. Missing token for authenticated endpoints (most endpoints need it)
  //    Public reads can work without token for public repos, but we require it for consistency
  if (!tokenPresent && isWrite) {
    return { decision: 'deny', reason: 'GitHub token not configured. Set GITHUB_TOKEN env var.', requiresApproval: false };
  }

  // 3. Subagent write → deny (subagents never write)
  if (isSubagent && isWrite) {
    return { decision: 'deny', reason: `Subagents may not perform GitHub write actions: ${toolName}`, requiresApproval: false };
  }

  // 4. ReadOnly mode → deny writes
  if (readOnly && isWrite) {
    return { decision: 'deny', reason: 'GitHub integration is in read-only mode', requiresApproval: false };
  }

  // 5. Repo outside allowedRepos
  const fullRepo = `${owner}/${repo}`;
  const isAllowed = allowedRepos.length === 0 || allowedRepos.some(r => r.toLowerCase() === fullRepo.toLowerCase());
  if (!isAllowed) {
    if (permissionMode === 'default' || permissionMode === 'auto-safe') {
      return { decision: 'deny', reason: `Repo "${fullRepo}" is not in allowedRepos`, requiresApproval: false };
    }
    return { decision: 'ask', reason: `Repo "${fullRepo}" is not in allowedRepos — requires approval`, requiresApproval: true };
  }

  // 6. Write actions → ask
  if (isWrite) {
    return {
      decision: 'ask',
      reason: `GitHub write action "${toolName}" requires approval`,
      requiresApproval: true,
    };
  }

  // 7. Read actions → allow
  return {
    decision: 'allow',
    reason: `GitHub read action "${toolName}" allowed`,
    requiresApproval: false,
  };
}
