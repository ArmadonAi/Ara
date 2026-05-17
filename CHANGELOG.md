# Changelog

## v0.2.0 (2026-05-18)

### Added

- **Release packaging tooling**: Version bump automation, release checklist, verification scripts.
- **`ara doctor` enhancements**: Checks for permissions engine, lock system, checkpoint availability, MCP config presence, GitHub config presence, and local path leakage detection.
- **GitHub Release Checklist**: Step-by-step guide for pre-release, build, and post-release verification.

### Changed

- **Version bump**: All packages and apps updated from v0.1.0 → v0.2.0 (21 package.json files, 3 source files, 2 docs).

### Security

- **Path leakage detection**: `ara doctor` now scans for file:/// absolute paths in source code.
- **Config validation**: Missing or malformed MCP/GitHub configs reported with graceful messaging.

### Known Limitations

See [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md) for full list.

### Verification

- 318+ tests passing, 0 failing
- TypeScript strict mode: 0 errors
- Build: API, Web (Vite), CLI bundled
- `ara doctor` passes all checks with API online
- `ara status` returns clean diagnostics

## v0.1.0 (2026-05-18)

First usable release of Ara Personal AI Control Plane.

### Added

- **CLI/TUI Gateway**: Commander.js CLI with 40+ commands. React Ink TUI with 13 tabs.
- **Memory & Skills**: Markdown-based memory store (USER.md, MEMORY.md). YAML frontmatter skill loader (SKILL.md).
- **Slash Commands**: In-chat commands for model switching, permissions, hooks, checkpoints, MCP, GitHub, canvas, locks, skills.
- **Structured Compaction**: Automatic context pruning for long conversations.
- **JSONL Transcripts**: Event-replayable session transcripts at `.ara/sessions/<id>.jsonl`.
- **Permission Engine**: 5 security modes (plan, default, accept-edits, auto-safe, danger-review). 21 default deny rules. Path confinement, symlink protection, secret scanning.
- **Lifecycle Hooks**: 18 event types across session, tool, MCP, GitHub, lock, and subagent lifecycles. Command and HTTP hook types.
- **Read-only Subagents**: Profile-based isolated execution. Tool allowlist with namespace wildcards. Parallel scheduling.
- **Checkpoint & Rewind**: Workspace file snapshots. Session state snapshots. Diff and restore with mode selection.
- **MCP / External Tools**: stdio and HTTP transports. Server registry with lifecycle management. Tool adapter with full safety pipeline. Permission mapper with 10 evaluation paths. Persistent JSONL audit.
- **GitHub Integration**: 13 tools (10 read, 3 write). REST client with rate limit/error handling. Token-redacted audit. Repo allowlist enforcement.
- **Parallel Subagents + File Locks**: Read/write lock manager. Path conflict precision. Deadlock detection. Stale lock cleanup. Persistent lock audit. TTL-based expiry.
- **Canvas / Workspace Nodes**: 13 node types, 5 edge types. File-based persistence. Node factories. Web UI Canvas page.
- **Skill Learning Loop**: Workflow fingerprint detection. Draft generation with secret redaction. Approval/versioning workflow. Skill usage statistics. Persistent fingerprints and stats.

### Security

- Fail-closed lock fallback — mutating operations blocked if lock module unavailable
- File locks acquired before write_file/edit_file and mutating run_shell
- Lock released in finally block on success, failure, or cancellation
- edit_file validates oldString exists and checks duplicate occurrences
- GitHub tokens read from env var only, redacted in all logs
- MCP audit redacts API keys, PATs, and credentials
- Permission engine denies .env, private keys, dangerous shell patterns
- Subagents cannot write, self-approve, or start/stop MCP servers
- Canvas actions route through API — no direct store access

### Known Limitations

See [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md) for full list.

### Verification

- 318 tests passing, 0 failing
- TypeScript strict mode: 0 errors
- Build: API, Web (Vite), CLI (1.64 MB bundle)
- All smoke tests pass with missing config/token/API
