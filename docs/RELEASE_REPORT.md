# Release Report

## Version Target

**v0.1-RC1** — Initial release candidate for personal AI control plane.

## Completed Modules

| Module | Status |
|---|---|
| CLI/TUI Gateway | Complete |
| Memory & Skills | Complete |
| Slash Commands | Complete |
| Structured Compaction | Complete |
| JSONL Transcripts | Complete |
| Permission Engine | Complete |
| Lifecycle Hooks | Complete |
| Read-only Subagents | Complete |
| Checkpoint/Rewind | Complete |
| MCP / External Tools | Complete |
| GitHub Integration | Complete |
| Parallel Subagents + File Locks | Complete |
| Canvas / Workspace Nodes | Complete |
| Skill Learning Loop | Complete |
| Release Hardening | Complete |

## Verification Results

| Check | Result |
|---|---|
| `bun test` | 318 pass, 0 fail (18 files, 790 expect) |
| `bun run typecheck` | Clean (0 errors) |
| `bun run build` | API: OK, Web: OK, CLI: 1.64 MB |
| `bun run build:cli` | 137 modules bundled |

## Manual Smoke Results

| Command | Expected | Result |
|---|---|---|
| `ara status` | Status or config error | Graceful |
| `ara doctor` | Diagnostics | Graceful |
| `ara chat "hello"` | Streams response or connection error | Graceful |
| `ara sessions` | Session list or empty | Graceful |
| `ara memory` | Memory list or empty | Graceful |
| `ara skills` | Skill list | Graceful |
| `ara skills suggest` | Learning overview | Graceful |
| `ara permissions` | Permission status | Graceful |
| `ara hooks` | Hook config | Graceful |
| `ara checkpoints` | Checkpoint list | Graceful |
| `ara locks` | Lock list | Graceful |
| `ara mcp health` | Health info | Graceful |
| `ara github status` | Status or config error | Graceful |
| `ara canvas list` | Workspace list or empty | Graceful |
| `ara subagents list` | Subagent list | Graceful |

## TUI Smoke Results

| Tab | Behavior |
|---|---|
| Chat | Renders with/without sessions |
| Subagents | Profile list |
| Approvals | Pending list or empty |
| Checkpoints | Checkpoint list |
| MCP | Server list |
| GitHub | Status display |
| Locks | Lock list |
| Canvas | Workspace list |
| Tools | Tool list |
| Memory | Memory items |
| Skills | Skill list |
| Learning | Learning overview + drafts |
| Audit | Audit log entries |
| Status | System status |

All tabs render without crashes on missing config/token/API. API offline state displayed.

## Security Audit

| Check | Result |
|---|---|
| write_file requires approval | Confirmed |
| edit_file requires approval | Confirmed |
| run_shell requires approval | Confirmed |
| mutating run_shell acquires lock | Confirmed |
| edit_file acquires lock | Confirmed |
| .env access denied | Confirmed |
| Private keys denied | Confirmed |
| Rejected approval never executes | Confirmed |
| Denied permission writes audit | Confirmed |
| MCP untrusted mutation asks | Confirmed |
| GitHub writes require approval | Confirmed |
| Subagents cannot write | Confirmed |
| Canvas actions call API | Confirmed |

## Known Limitations

See [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) for full list.

Key limitations:
- Single-user, localhost-only
- JSONL files grow unbounded
- Draft body is tool-sequence-based (no semantic content)
- No OAuth for GitHub
- Write-enabled parallel subagents disabled

## Recommended Release Status

**Ready with caveats.**

Ara v0.1-RC1 is suitable for:
- Personal local development
- Single-user AI workspace control
- Experimental tool integration via MCP
- GitHub read/write workflows with approval

Not yet suitable for:
- Multi-user deployments
- Public internet exposure
- Production CI/CD pipelines
- Untrusted third-party access
