# Ara System Architecture

## Overview

Ara is a local-first personal AI control plane built as a Bun monorepo. It provides a secure runtime for AI agents with tools, permissions, hooks, checkpoints, and external service integration.

## Package Architecture

```
apps/
  web/        React/Vite dashboard — chat UI, session management, status
  api/        Hono REST/SSE server + SQLite — central brain, 60+ API routes
  worker/     Cron scheduler — headless automation execution
  cli/        Commander.js CLI + React Ink TUI — 40+ commands, 13 tabs

packages/
  shared/        Core types, interfaces, Zod schemas
  agent-core/    ReAct loop orchestrator — streamAgentLoop()
  tools/         ToolRegistry + 7 tools (list_files, read_file, write_file, edit_file, run_shell, git_status, git_diff, delegate_task)
  permissions/   evaluatePermission() — 5 modes, 21 deny rules
  hooks/         18 lifecycle event types — command/http execution
  model-router/  Gemini, OpenAI, Anthropic, Ollama providers
  memory/        USER.md + MEMORY.md parsing
  skills/        SKILL.md YAML frontmatter loader
  commands/      Slash command registry — /help, /model, /mcp, /github, /locks, /canvas, /skills, ...
  checkpoints/   Workspace snapshot, diff, restore
  subagents/     Read-only subagent profiles, isolated execution, parallel scheduling
  locks/         Read/write file locking, deadlock detection, persistent audit
  mcp/           MCP client/server registry, tool adapters, permission mapper, persistent audit
  github/        GitHub REST client, 13 tools, permission mapper, token-redacted audit
  canvas/        Workspace node model, file-based storage, node/edge factories
  skill-learning/Workflow detection, draft generation, skill versioning, usage stats
```

## Data Flow

```
User Input
  → API Server (Hono SSE)
  → AgentRuntime.streamAgentLoop()
  → LLM (ModelRouter)
  → Tool Call Detected
  → Permission Engine (evaluatePermission)
  → PreToolUse Hook
  → Approval Gate (if ask)
  → Checkpoint (if mutating)
  → File Lock (if mutating)
  → Tool Execution
  → PostToolUse / ToolFailed Hook
  → Audit Log
  → Response Streamed to User
```

## Storage

| Data | Location | Format |
|---|---|---|
| Sessions, messages, approvals | `ara.sqlite` | SQLite |
| Session transcripts | `.ara/sessions/<id>.jsonl` | JSONL |
| Checkpoints | `.ara/checkpoints/` | JSON + file snapshots |
| MCP audit | `.ara/audit/mcp.jsonl` | JSONL |
| Lock audit | `.ara/audit/locks.jsonl` | JSONL |
| Canvas workspaces | `.ara/canvas/workspaces/<id>.json` | JSON |
| Skill drafts | `.ara/skill-drafts/<id>.json` | JSON |
| Workflow fingerprints | `.ara/skill-learning/workflows.jsonl` | JSONL |
| Skill usage stats | `.ara/skill-learning/usage.jsonl` | JSONL |
| Agent profiles | `.ara/agents/*.md` | Markdown |
| Settings | `.ara/settings.json` | JSON |
| Skills | `skills/<name>/SKILL.md` | Markdown |
| Memory | `memory/USER.md`, `memory/MEMORY.md` | Markdown |
