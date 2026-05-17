# GitHub Integration

Ara provides safe read and write access to GitHub repositories, issues, pull requests, checks, and workflow runs.

## Architecture

```
Agent proposes GitHub tool (github.get_repo, github.create_issue, etc.)
  |
  v
Ara Tool Registry → GitHubBaseTool.run()
  |
  v
Safety Pipeline:
  1. Permission Mapper (mapGitHubPermission)
     - allowedRepos check
     - read vs write check
     - subagent write deny
     - token present check
  2. GitHub REST Client (fetch)
  3. Audit log (writeGitHubAudit)
```

## Config Format (`.ara/github.json`)

```json
{
  "enabled": true,
  "defaultOwner": "JonusNattapong",
  "defaultRepo": "Ara",
  "apiBaseUrl": "https://api.github.com",
  "tokenEnv": "GITHUB_TOKEN",
  "permissionMode": "default",
  "allowedRepos": ["JonusNattapong/Ara"],
  "readOnly": false
}
```

### Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | true | Enable/disable GitHub integration |
| `defaultOwner` | string | - | Default owner for CLI commands |
| `defaultRepo` | string | - | Default repo for CLI commands |
| `apiBaseUrl` | string | `https://api.github.com` | GitHub API base URL |
| `tokenEnv` | string | `GITHUB_TOKEN` | Environment variable name for the token |
| `permissionMode` | enum | `default` | Permission mode for GitHub actions |
| `allowedRepos` | string[] | [] | Allowed repos list (empty = all allowed) |
| `readOnly` | boolean | false | Restrict to read-only operations |

### Token Safety

- **Never store token value in config.** The `tokenEnv` field specifies the environment variable name.
- Token is read at runtime from `process.env[tokenEnv]`
- Full `process.env` is never passed to GitHub client
- Tokens are redacted in all audit logs
- Token patterns redacted: `ghp_*`, `github_pat_*`, `Authorization: Bearer *`

## Tools

### Read Tools (safe, no approval)

| Tool | Description | Resource |
|---|---|---|
| `github.get_repo` | Get repository details | repo |
| `github.list_issues` | List issues filtered by state | issue |
| `github.get_issue` | Get a specific issue | issue |
| `github.list_pull_requests` | List pull requests | pull_request |
| `github.get_pull_request` | Get PR details | pull_request |
| `github.get_pull_request_files` | List changed files in PR | pull_request |
| `github.get_pull_request_diff` | Get unified diff of PR | pull_request |
| `github.list_check_runs` | List check runs for a ref | check |
| `github.list_workflow_runs` | List workflow runs | workflow |
| `github.get_workflow_run` | Get workflow run details | workflow |

### Write Tools (requires approval)

| Tool | Danger | Description |
|---|---|---|
| `github.create_issue` | write | Create a new issue |
| `github.comment_issue` | write | Comment on an issue |
| `github.create_pull_request_review` | write | Create a PR review |

## Permission Model

| Rule | Decision |
|---|---|
| Read tool, repo allowed | allow |
| Write tool, repo allowed | **ask** |
| Write tool, readOnly mode | deny |
| Subagent write tool | deny |
| Write tool, no token | deny |
| Repo not in allowedRepos (default mode) | deny |
| Repo not in allowedRepos (accept-edits mode) | ask |
| Unknown tool | deny |

### Approval Requirements

Write actions require explicit approval. The tool returns `awaitingApproval: true` which the CLI/TUI/Slash handler displays as an approval prompt.

## Subagent Rules

- Subagents may call read-only GitHub tools if profile allowlist includes them
- Subagents cannot call write GitHub tools (denied at permission mapper level)
- Subagents cannot approve GitHub write actions
- Subagents cannot access repos outside allowedRepos

## API Routes

| Method | Path | Description |
|---|---|---|
| GET | `/api/github` | Integration overview |
| GET | `/api/github/status` | Detailed health status |
| GET | `/api/github/repos/:owner/:repo` | Get repository |
| GET | `/api/github/repos/:owner/:repo/issues` | List issues |
| GET | `/api/github/repos/:owner/:repo/issues/:number` | Get issue |
| POST | `/api/github/repos/:owner/:repo/issues` | Create issue (write) |
| POST | `/api/github/repos/:owner/:repo/issues/:number/comments` | Comment on issue (write) |
| GET | `/api/github/repos/:owner/:repo/pulls` | List PRs |
| GET | `/api/github/repos/:owner/:repo/pulls/:number` | Get PR |
| GET | `/api/github/repos/:owner/:repo/pulls/:number/files` | Get PR files |
| GET | `/api/github/repos/:owner/:repo/pulls/:number/diff` | Get PR diff |
| POST | `/api/github/repos/:owner/:repo/pulls/:number/reviews` | Create PR review (write) |
| GET | `/api/github/repos/:owner/:repo/check-runs/:ref` | List check runs |
| GET | `/api/github/repos/:owner/:repo/actions/runs` | List workflow runs |

Write routes go through Permission Engine + Approval Gate + audit.

## CLI Commands

```bash
# Status
ara github status

# Repository info
ara github repo owner/repo

# Issues
ara github issues owner/repo
ara github issue <number> owner/repo

# Pull requests
ara github prs owner/repo
ara github pr <number> owner/repo
ara github pr files <number> owner/repo
ara github pr diff <number> owner/repo

# Checks and workflows
ara github checks <ref> owner/repo
ara github runs owner/repo

# Write commands (require approval)
ara github issue-create --title "Fix bug" --body "Details" [--owner-repo owner/repo]
ara github issue-comment <number> --body "Looks good" [--owner-repo owner/repo]
ara github pr-review <number> --body "LGTM" --event APPROVE [--owner-repo owner/repo]
```

## Slash Commands

```
/github status                — Integration status
/github issues [owner/repo]   — List issues
/github prs [owner/repo]      — List PRs
/github checks <ref> [o/r]   — List check runs
```

## Audit

Every GitHub action writes audit logs with redacted tokens.

Audit fields: id, sessionId, toolName, owner, repo, resourceType, resourceId, inputSummary, outputSummary, status, dangerLevel, permissionDecision, approvalId, startedAt, finishedAt, durationMs, error.

## Hooks

GitHub actions fire standard Ara lifecycle hooks:

- `PreToolUse` — Before GitHub API call
- `PostToolUse` — After successful API call
- `ToolFailed` — On API failure

Additionally, GitHub-specific lifecycle events:

- `GitHubActionStart` — Before execution (payload includes owner/repo/resource type)
- `GitHubActionEnd` — On successful execution
- `GitHubActionFailed` — On permission deny or API failure
- `GitHubWriteApprovalRequested` — Before write approval is required

All hook payloads are redacted. Tokens are never included.

## TUI Tab

The GitHub tab in the TUI dashboard shows:
- Integration status (enabled/configured/token present)
- Default owner/repo
- Read-only mode flag
- Allowed repos list
- Open issues (up to 5)
- Open pull requests (up to 5)
- Token environment variable name (never token value)

Read-only in v0.1. No write actions from TUI.

## Pagination

List endpoints support pagination:

| Parameter | Type | Default | Range |
|---|---|---|---|
| `page` | integer | 1 | >= 1 |
| `per_page` | integer | 30 | 1-100 |

API: `/api/github/repos/owner/repo/issues?page=2&per_page=50`

## Approval Flow for Write Commands

Write commands (`issue-create`, `issue-comment`, `pr-review`) require approval:

1. User runs CLI command with required options
2. Tool calls Permission Engine → returns `ask`
3. CLI prints: `🛡️ This action requires manual approval.`
4. User runs `ara approve <id>` to authorize
5. Tool executes after approval

## Limitations (v0.1)

- **No OAuth**: Token-based auth only via env var
- **No branch protection**: API does not enforce branch rules
- **No merge/close tools**: Write actions limited to issues, comments, reviews
- **No webhooks**: No GitHub event subscription
- **No MCP integration**: Native tools are first-class; MCP GitHub server can coexist
- **No rate limit caching**: Each request checks rate limit independently
