# Ara

## Badge

![Release](https://img.shields.io/github/v/tag/DrakonArt/Ara?color=blue&label=Release&style=for-the-badge)
![License](https://img.shields.io/github/license/DrakonArt/Ara?style=for-the-badge)
![TypeScript](https://img.shields.io/badge/TypeScript-strict--only-3178c6?style=for-the-badge&logo=typescript)
![Bun](https://img.shields.io/badge/Bun-fast-000000?style=for-the-badge&logo=bun)
![Tests](https://img.shields.io/badge/318_Tests_Passing-green?style=for-the-badge)
![Status](https://img.shields.io/badge/Status-Early_development-red?style=for-the-badge)
![Language](https://img.shields.io/badge/Language-TypeScript-3178c6?style=for-the-badge&logo=typescript)

## Description

Ara is a secure, local-first personal AI assistant and autonomous workspace control plane. Developed as an integrated Bun monorepo, Ara delivers a high-integrity runtime environment featuring web dashboards, terminal interfaces, fine-grained safety policies, MCP external tool integration, GitHub integration, read-only subagents, checkpoint/rewind, and an extensible lifecycle hooks architecture.

---

## Key Capabilities

* **Web Control Dashboard**: High-performance React/Vite dashboard with SSE streaming, real-time typing, collapsible thought logs, and interactive tool-execution monitoring.
* **CLI/TUI Gateway**: Responsive CLI and fullscreen terminal UI built with Commander.js and React Ink.
* **ReAct Agent Runtime**: Autonomous planning and execution agent loop with tool calling and dynamic feedback digestion.
* **Permission Engine**: Policy-driven access controller with 5 modes (`plan`, `default`, `accept-edits`, `auto-safe`, `danger-review`) and 21 default deny rules for credentials, secrets, and dangerous commands.
* **Lifecycle Hooks System**: Hooks for `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `ToolFailed`, `SessionEnd`, plus MCP and GitHub lifecycle events.
* **MCP / External Tools**: Load, start, and call tools from MCP servers (stdio/HTTP) through the full Ara safety pipeline with permission mapping, audit, and checkpointing.
* **GitHub Integration**: Read and write access to repositories, issues, pull requests, checks, and workflow runs — all through the Permission Engine and Approval Gate.
* **Read-Only Subagents**: Delegate tasks to specialized subagents (researcher, code-reviewer, debugger) with isolated execution context and profile-based tool allowlists.
* **Checkpoint & Rewind**: Automatic file backups to `.ara/backups/` before mutations, with full checkpoint/restore workflow.
* **Slash Commands**: In-chat commands for model switching, context management, permissions, hooks, checkpoints, MCP, and GitHub.
* **Local Memory & Skills**: Progressive markdown loaders that parse USER.md, MEMORY.md, and SKILL.md files with YAML frontmatter.
* **OpenClaw & Hermes Migration**: Automatic detectors and interactive/scripted migration wizards to seamlessly import settings, API keys/secrets, memory facts, and skill procedures from existing OpenClaw (`~/.openclaw`) or Hermes (`~/.hermes`) installations.

---

## Monorepo Workspace Structure

```
apps/
  web/           React / Vite / TypeScript Dashboard UI
  api/           Hono REST API / SSE Chat Gateway & SQLite DB
  worker/        Background Cron Scheduler & Automation Worker
  cli/           CLI & fullscreen Terminal UI (TUI) binary gateway

packages/
  shared/        Core interfaces, types & Zod schemas
  agent-core/    ReAct Loop orchestrator & system prompters
  tools/         Filesystem, Git, Sandboxed Shell, and DelegateTask tools
  memory/        Local Markdown USER.md / MEMORY.md parser
  skills/        YAML Frontmatter progressive SKILL.md loader
  permissions/   Policy evaluation, symlink checks, path safety filters
  hooks/         Lifecycle hooks executor, timeout constraints, HTTP/Command runners
  model-router/  Cloud & Offline Provider Adapters (Gemini, OpenAI, Anthropic, Ollama)
  commands/      Slash command registry (/help, /model, /permissions, /hooks, /mcp, /github, ...)
  checkpoints/   Workspace snapshot, diff, and restore for code and conversation state
  subagents/     Read-only subagent profiles, isolated execution, and result merging
  mcp/           MCP client/server registry, tool adapters, permission mapper, persistent audit
  github/        GitHub REST client, 13 tools, permission mapper, token-redacted audit
```

---

## Installation and Setup

### 1. Prerequisites

[Bun](https://bun.sh) v1.3+ is required.

### 2. Dependency Installation

```bash
bun install
```

### 3. Environment Configuration

```bash
cp .env.example .env
```

Populate the environment variables:

```ini
GEMINI_API_KEY=AIza...
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
OLLAMA_HOST=http://127.0.0.1:11434
GITHUB_TOKEN=ghp_...
USE_DOCKER_SANDBOX=false
```

### 4. MCP Configuration (Optional)

Create `.ara/mcp.json` to register MCP tool servers:

```json
{
  "servers": [
    {
      "id": "filesystem",
      "name": "Filesystem",
      "type": "stdio",
      "command": "node",
      "args": ["mcp-server.js"],
      "enabled": true,
      "trusted": false
    }
  ]
}
```

### 5. GitHub Configuration (Optional)

Create `.ara/github.json`:

```json
{
  "enabled": true,
  "defaultOwner": "your-username",
  "defaultRepo": "your-repo",
  "tokenEnv": "GITHUB_TOKEN",
  "allowedRepos": ["your-username/your-repo"],
  "readOnly": false
}
```

---

## Workspace Commands

| Command | Description |
|---|---|
| `bun run dev` | Run Web UI, Hono API, and Worker concurrently |
| `bun run dev:web` | Start React Vite frontend |
| `bun run dev:api` | Start Hono REST API |
| `bun run dev:worker` | Start background cron worker |
| `bun run dev:cli` | CLI / TUI gateway |
| `bun run build` | Build all apps |
| `bun run build:cli` | Bundle CLI binary |
| `bun run typecheck` | TypeScript compiler validation |
| `bun test` | Run test suite |
| `bun run clean` | Purge build artifacts |

---

## CLI & TUI

```bash
ara                              # Open fullscreen TUI dashboard
ara tui                          # Open TUI
ara chat "prompt"                # One-shot query
ara chat                         # Interactive chat
ara approvals                    # List pending approvals
ara approve <id>                 # Grant approval
ara reject <id>                  # Deny approval
ara permissions                  # View permission mode
ara permissions mode <mode>      # Set permission mode
ara hooks                        # List hooks
ara hooks validate               # Validate hooks config
ara mcp servers                  # List MCP servers
ara mcp tools                    # List MCP tools
ara mcp start <id>               # Start MCP server
ara mcp call <tool> --json '{}'  # Call MCP tool
ara github status                # GitHub integration status
ara github issues [o/r]         # List GitHub issues
ara github prs [o/r]            # List GitHub PRs
ara github issue-create --title "..."  # Create issue (requires approval)
ara openclaw migrate             # Interactive OpenClaw setup migration
ara hermes migrate              # Interactive Hermes setup migration
```

Full documentation: [docs/CLI.md](docs/CLI.md)

---

## Slash Commands

Available in TUI chat:

```
/help              - Show all commands
/model [name]      - Switch model
/compact           - Compact context
/permissions       - View/set permission mode
/hooks             - View/validate hooks
/checkpoint        - Create/show/diff checkpoints
/restore <id>      - Restore checkpoint
/mcp servers       - List MCP servers
/mcp tools         - List MCP tools
/mcp health        - MCP health check
/github status     - GitHub status
/github issues     - List issues
/github prs        - List PRs
```

---

## MCP / External Tools

Ara integrates with the Model Context Protocol (MCP) for external tool servers.

**Transports**: stdio (child process) and HTTP (JSON-RPC 2.0)

**Safety pipeline**:

1. Permission Engine evaluation (10 evaluation paths)
2. PreToolUse / PostToolUse / ToolFailed hooks
3. Checkpoint creation for mutating tools
4. Audit log with secret redaction

**Server lifecycle**: `stopped → starting → healthy → unhealthy/error`

**CLI**: `ara mcp servers`, `ara mcp start <id>`, `ara mcp tools`, `ara mcp call`

**Config**: `.ara/mcp.json` — see [docs/MCP.md](docs/MCP.md)

---

## GitHub Integration

Ara provides 13 GitHub tools through the Tool Registry.

**Read tools** (10): get_repo, list_issues, get_issue, list_pull_requests, get_pull_request, get_pull_request_files, get_pull_request_diff, list_check_runs, list_workflow_runs, get_workflow_run

**Write tools** (3, require approval): create_issue, comment_issue, create_pull_request_review

**Token safety**: Read from env var only (`GITHUB_TOKEN`), never stored in config, redacted in all audit logs

**Config**: `.ara/github.json` — see [docs/GITHUB.md](docs/GITHUB.md)

---

## Security Model

1. **Multi-Tier Approvals**: Write and shell operations require explicit approval via CLI or UI.
2. **5 Permission Modes**: `plan`, `default`, `accept-edits`, `auto-safe`, `danger-review` — each with different allow/ask/deny defaults.
3. **21 Default Deny Rules**: `.env*`, `~/.ssh/**`, `*.pem`, `rm -rf`, `sudo`, `curl|sh`, `DROP TABLE`, credential patterns.
4. **Path Confinement**: All file operations restricted to CWD. Symlink escape blocked.
5. **Secret Scanning**: Credential patterns scanned before write/shell execution.
6. **Environment Scrubbing**: System env vars purged before hook execution. MCP server env strictly scoped.
7. **Docker Sandbox**: Optional container isolation for shell operations.
8. **Audit Logging**: All tool calls logged with secret redaction (`sk-*`, `AIza*`, `ghp_*`, `glpat-*`).
9. **MCP Safety**: Hard deny for secrets, shell commands on untrusted servers. Mutating tools require checkpoint + approval.
10. **GitHub Safety**: Repo allowlists, read-only mode, subagent write deny, token redaction.

---

## Configuration

### `.ara/settings.json`

Lifecycle hooks configuration (local or `~/.ara/settings.json`):

```json
{
  "hooks": [
    {
      "name": "workspace-integrity",
      "type": "command",
      "events": ["SessionStart"],
      "command": "git diff-index --quiet HEAD --",
      "timeoutMs": 3000
    }
  ]
}
```

### `.ara/mcp.json`

MCP server configuration — see [docs/MCP.md](docs/MCP.md).

### `.ara/github.json`

GitHub integration configuration — see [docs/GITHUB.md](docs/GITHUB.md).

---

## Documentation

* [Architecture & Design](docs/ARCHITECTURE.md)
* [API Reference](docs/API.md)
* [CLI Reference](docs/CLI.md)
* [Permission Model](docs/PERMISSIONS.md)
* [Hooks System](docs/HOOKS.md)
* [Checkpoints & Rewind](docs/CHECKPOINTS.md)
* [Subagents](docs/SUBAGENTS.md)
* [MCP / External Tools](docs/MCP.md)
* [GitHub Integration](docs/GITHUB.md)
* [Release Checklist](docs/RELEASE_CHECKLIST.md)
