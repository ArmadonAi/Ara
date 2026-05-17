# Ara v0.2.0 Release Notes

## What Ara Is

Ara is a local-first personal AI control plane. It gives you a secure, auditable runtime for AI agent workflows — with tools, permissions, external service integration, and full control over what the agent can do.

## What's New in v0.2.0

- **Enhanced diagnostics**: `ara doctor` now checks permissions, locks, checkpoints, MCP/GitHub configs, and path leakage.
- **Release tooling**: Standardized versioning, changelog, and release checklist for future releases.
- **All v0.1.0 features** remain stable and verified.

## What Works

- **Chat with AI agents** via CLI, TUI, or web dashboard (requires API server)
- **File and shell tools** with safety gates (approval, permissions, checkpoints, locks)
- **External tool servers** via MCP protocol (stdio and HTTP)
- **GitHub integration** — read issues/PRs, create issues, comment, review PRs
- **Skill learning** — detects repeated workflows, drafts reusable skills
- **Canvas workspace** — organize chats, files, tasks, and GitHub objects as nodes
- **Subagents** — delegate read-only tasks to specialized profiles
- **Checkpoints** — snapshot and restore workspace files and conversation state
- **File locks** — prevent concurrent write conflicts
- **Lifecycle hooks** — run commands or HTTP calls on session/tool events
- **`ara doctor`** — full environment diagnostics including subsystem checks
- **`ara status`** — standalone CLI diagnostics without API dependency

## How to Install

```bash
# Prerequisites: Bun v1.3+
bun install
```

No API keys are required for basic functionality (mock mode streams a config reminder). For LLM features, set at least one of:
- `GEMINI_API_KEY`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `OLLAMA_HOST` (default `http://127.0.0.1:11434`)

## How to Run

```bash
# Start the API server (required for chat, tools, and most features)
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

# Chat (requires API server)
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
8. **Mode Enforcement**: Default deny rules for `.env`, private keys, dangerous shell patterns
9. **Fail-closed**: Locks block mutating operations if lock module unavailable

## Known Caveats

- Single-user, localhost-only
- No built-in HTTPS or authentication
- JSONL audit files grow without automatic cleanup
- GitHub integration uses token-based auth (no OAuth)
- MCP servers must be configured manually in `.ara/mcp.json`
- Write-enabled parallel subagents are disabled by default
- Canvas workspace has no drag-and-drop canvas board
- No backup rotation — `.ara/backups/` accumulates without cleanup
- No rate limiting on API

## Recommended Use

Ara v0.2.0 is suitable for:
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

## Verification

- 318+ tests passing, 0 failing
- TypeScript strict mode: 0 errors
- Build: API, Web (Vite), CLI (bundled)
- `ara doctor` passes all subsystem checks with API online
- All smoke tests pass with missing config/token/API
