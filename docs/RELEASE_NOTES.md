# Ara v0.1.0 Release Notes

## What Ara Is

Ara is a local-first personal AI control plane. It gives you a secure, auditable runtime for AI agent workflows — with tools, permissions, external service integration, and full control over what the agent can do.

## What Works

- **Chat with AI agents** via CLI, TUI, or web dashboard
- **File and shell tools** with safety gates (approval, permissions, checkpoints, locks)
- **External tool servers** via MCP protocol (stdio and HTTP)
- **GitHub integration** — read issues/PRs, create issues, comment, review PRs
- **Skill learning** — detects repeated workflows, drafts reusable skills
- **Canvas workspace** — organize chats, files, tasks, and GitHub objects as nodes
- **Subagents** — delegate read-only tasks to specialized profiles
- **Checkpoints** — snapshot and restore workspace files and conversation state
- **File locks** — prevent concurrent write conflicts
- **Lifecycle hooks** — run commands or HTTP calls on session/tool events

## How to Install

```bash
# Prerequisites: Bun v1.3+
bun install
cp .env.example .env
# Edit .env with your API keys (at least one LLM provider)
```

## How to Run

```bash
# Start the API server (required for most features)
bun run dev:api

# In another terminal, start the TUI
bun run dev:cli
# or
ara tui

# One-shot commands work without the API running
ara doctor
ara status
```

## CLI Examples

```bash
# Status and diagnostics
ara doctor
ara status

# Chat
ara chat "Explain the architecture"

# Permissions
ara permissions
ara permissions mode accept-edits

# MCP tools
ara mcp servers
ara mcp tools

# GitHub
ara github status
ara github issues owner/repo

# Canvas
ara canvas list
ara canvas create "My Project"

# Skill learning
ara skills suggest
ara skills analyze-recent --limit 10
ara skills drafts

# File locks
ara locks list
ara locks cleanup

# Checkpoints
ara checkpoints

# Subagents
ara subagents list
```

## Safety Model

1. **Permission Engine**: 5 modes controlling what tools can do without approval
2. **Approval Gate**: Write/dangerous operations paused for user approval
3. **Checkpoints**: Files backed up before mutation
4. **File Locks**: Exclusive write locks prevent concurrent conflicts
5. **Audit Logs**: Every tool call recorded with secret redaction
6. **Path Safety**: All file operations confined to workspace directory
7. **Secret Scanning**: Credential patterns detected before write/shell execution

## Known Caveats

- Single-user, localhost-only
- No built-in HTTPS or authentication
- JSONL audit files grow without automatic cleanup
- GitHub integration uses token-based auth (no OAuth)
- MCP servers must be configured manually in `.ara/mcp.json`
- Write-enabled parallel subagents are disabled by default
- Canvas workspace has no drag-and-drop canvas board

## Recommended Use

Ara v0.1.0 is suitable for:
- Personal local development
- Single-user AI workspace automation
- Experimenting with MCP tool servers
- GitHub read/write workflows with explicit approval
- Learning and skill discovery from repeated workflows

Not yet suitable for:
- Multi-user team environments
- Public internet exposure
- Production CI/CD pipelines
- Untrusted third-party access
