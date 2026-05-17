# Known Limitations (v0.2.0)

## Storage

- **SQLite only**: Not designed for multi-user or high-concurrency access
- **JSONL files grow unbounded**: No automatic compaction for transcripts, audit, fingerprints, or usage stats
- **In-memory caches**: Lock store, skill usage stats are in-memory (audit and some stats persist to JSONL)
- **File-based canvas storage**: No relational queries across workspaces

## MCP

- **No tool discovery refresh on change**: Tools discovered once at server start; refresh requires explicit API call
- **No streaming tool calls**: Tools execute synchronously (blocking)
- **stdio health check fallback**: Falls back to process liveness if protocol ping unsupported
- **No client pooling**: One client instance per server config

## GitHub

- **No OAuth**: Token-based auth only via environment variable
- **No merge/close tools**: Write actions limited to issues, comments, PR reviews
- **No webhooks**: No GitHub event subscription
- **No pagination in CLI list commands**: API accepts page/perPage but CLI doesn't expose them as flags

## Subagents

- **Write-enabled parallel subagents disabled**: Only read-only parallel execution supported
- **No per-agent custom tasks**: Shared task string applied to all agents in parallel run
- **Keyword-based mutation detection**: `isMutatingCommand()` heuristic may have false positives/negatives

## Canvas

- **No drag-and-drop**: Nodes use absolute positioning via API; no visual canvas board with drag
- **No live collaboration**: Single-user workspace only
- **TUI Canvas tab is read-only**: No node/edge management from TUI

## Skill Learning

- **Draft body is tool-sequence-based**: No semantic transcript content in draft body
- **No version rollback**: No command to restore a previous skill version
- **No automatic transcript scanning**: Requires explicit POST to analyze endpoints

## General

- **No user authentication**: Single-user mode; not hardened for public internet
- **No HTTPS**: Designed for localhost use; reverse proxy required for remote access
- **No rate limiting**: No request throttling on API
- **No backup rotation**: `.ara/backups/` accumulates without cleanup
