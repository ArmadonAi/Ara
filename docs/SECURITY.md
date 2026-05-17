# Security Model

## Overview

Ara is designed with security as a core architectural constraint. Every tool call goes through a multi-layer safety pipeline.

## Safety Pipeline

```
Tool Call
  → Permission Engine (evaluatePermission)
    → 5 modes: plan, default, accept-edits, auto-safe, danger-review
    → 21 default deny rules (.env, ssh, pem, rm -rf, sudo, etc.)
    → Path safety (CWD confinement, symlink escape prevention)
  → Approval Gate (if ask decision)
    → Approval required for: write_file, edit_file, run_shell, GitHub writes
    → Rejected approvals never execute
  → Checkpoint (if mutating)
    → File backup before write
    → Session snapshot before mutation
  → File Lock (if mutating)
    → Exclusive write lock prevents concurrent conflicts
  → Hook Lifecycle (PreToolUse, PostToolUse, ToolFailed)
  → Audit Log
```

## Permission Modes

| Mode | Behavior |
|---|---|
| `plan` | All tool calls ask for approval |
| `default` | Safe tools allowed; write/dangerous ask |
| `accept-edits` | File reads allowed; mutating writes ask |
| `auto-safe` | Only safe tools allowed |
| `danger-review` | All tools require review |

## Default Deny Rules (21)

- Credential files: `.env*`, `.ssh/**`, `.aws/**`, `.config/gcloud/**`
- Private keys: `*.pem`, `*.key`, `id_rsa`, `id_ecdsa`, `id_ed25519`
- Dangerous commands: `rm -rf`, `sudo`, `curl|sh`, reverse shells, `DROP TABLE`, `printenv`

## MCP Safety

- Untrusted servers: shell-like tools denied, mutating tools ask, file tools ask
- Trusted bypass after hard denies (allowlist, secrets)
- Secret patterns blocked in tool names/inputs
- Full process.env never passed to MCP servers

## GitHub Safety

- Token read from env var only (never config)
- Token redacted in all audit logs
- Write actions require approval
- Subagents cannot perform write actions
- Repo allowlist enforcement

## File Lock Safety

- Write lock is exclusive (blocks other writes and reads)
- Stale locks expire automatically (configurable TTL)
- Deadlock detection prevents circular waits
- Force release requires explicit reason

## Audit

- All tool calls audited
- MCP calls audited with secret redaction
- GitHub actions audited with token redaction
- Lock events audited
- Canvas actions audited
- Hook executions audited
- Skill learning events audited
