# Parallel Subagents & File Locks

Ara supports running multiple subagents in parallel and provides a file locking system to prevent concurrent write conflicts.

## Lock Model

### Lock Modes

| Mode | Description | Behavior |
|---|---|---|
| `read` | Shared read lock | Multiple sessions can hold read locks on the same path |
| `write` | Exclusive write lock | Blocks other reads and writes on the same path |

### Lock States

- `active` — Lock is held and enforced
- `released` — Lock was released normally
- `expired` — Lock TTL elapsed without release
- `force_released` — Admin force-released the lock

### Conflict Rules

| Existing Lock | Requested Lock | Result |
|---|---|---|
| read | read | ✅ Allowed (multiple readers) |
| read | write | ❌ Blocked |
| write | read | ❌ Blocked |
| write | write | ❌ Blocked |

### Path Conflict Detection

- Same file: always conflicts
- Parent directory vs child file: conflicts (both directions)
- Sibling files under same parent: does NOT conflict
- Windows paths: normalized case-insensitively

## Runtime Lock Flow

### write_file

```
validate input → scanForSecrets → acquire write lock → 
backup existing file → write file → release lock (finally)
```

### mutating run_shell

```
validate command → blocklist check → scanForSecrets → 
isMutatingCommand? → acquire workspace write lock → 
execute command → release lock (finally)
```

### Lock Release Guarantee

- Released on success
- Released on failure
- Released in `finally` block
- Lock conflict returns readable `[LOCK BLOCKED]` error

## Fail-Closed Behavior

By default, if the `@ara/locks` module cannot be loaded, mutating operations are **blocked**:

```
[LOCK SYSTEM UNAVAILABLE] File locking module not available.
Set ARA_ALLOW_LOCK_FALLBACK=1 to bypass, or ensure @ara/locks is installed.
```

To allow fallback (development only):
```bash
export ARA_ALLOW_LOCK_FALLBACK=1
```

When fallback is active, tools continue without locking and a warning is audited.

## Deadlock Detection

Ara detects circular wait deadlocks using a wait-for graph analysis:

- Session A holds file X and waits for file Y (held by B)
- Session B holds file Y and waits for file X (held by A)
- A simple conflict on the same resource is NOT a deadlock — it is normal contention

Deadlocked requests return: `[DEADLOCK] Deadlock detected between sessions: ...`

## Stale Lock Cleanup

- Every lock has a configurable TTL (default 30s)
- `cleanupExpiredLocks()` runs automatically before each `acquireLock()`
- Manual cleanup: `ara locks cleanup` or `POST /api/locks/cleanup`

## Lock Audit

All lock events are logged to `.ara/audit/locks.jsonl`:

- `lock.acquire_requested`
- `lock.acquired`
- `lock.conflict`
- `lock.deadlock_detected`
- `lock.released`
- `lock.expired`
- `lock.force_released`
- `lock.unavailable_fallback`

## Parallel Subagents

### Behavior

- Run multiple read-only subagents concurrently
- Configurable `maxConcurrency` (default 3)
- Queue pending profiles execute as workers free up
- AbortController-based cancellation
- Results collected in deterministic queue order

### Restrictions

- Write-enabled parallel subagents are **disabled by default**
- Read-only subagents can run in parallel without file locks
- If future write tools are enabled, write locks + checkpoints + approval are required

### Task Propagation

A shared task string is applied to all profiles. Each child receives `profileName` + `task`.

```
Input: ara subagents-parallel run researcher,code-reviewer "Analyze this repo"
→ researcher receives task="Analyze this repo"
→ code-reviewer receives task="Analyze this repo"
```

## CLI Commands

```bash
# Lock management
ara locks acquire <path> --mode read|write [--ttl <ms>]
ara locks release <lockId>
ara locks force-release <lockId> --reason "<reason>"
ara locks list [--status active|released|expired]
ara locks cleanup
ara locks audit [--limit <n>]

# Parallel subagent commands
ara subagents-parallel run <agent1,agent2,...> <task> [--concurrency <n>]
ara subagents-parallel runs
ara subagents-parallel run-info <id>
ara subagents-parallel cancel <id>
```

## Slash Commands

```
/locks list          — List active locks
/locks cleanup       — Clean expired locks
/parallel <a1,a2> <t> — Run parallel subagents
/parallel-runs       — List parallel runs
```

## TUI Locks Tab

The Locks tab shows:
- Active locks with mode, path, owner, expiration
- Parallel run status with agent count and results
- Recent lock audit events
- CLI and slash command hints

## API Routes

| Method | Path | Description |
|---|---|---|
| GET | `/api/locks` | List locks (optional `?status=`) |
| POST | `/api/locks` | Acquire a lock |
| POST | `/api/locks/:id/release` | Release a lock |
| POST | `/api/locks/:id/force-release` | Force-release a lock |
| POST | `/api/locks/cleanup` | Clean up expired locks |
| GET | `/api/locks/audit` | View lock audit records |
| POST | `/api/subagents/parallel-runs` | Start parallel run |
| GET | `/api/subagents/parallel-runs` | List parallel runs |
| GET | `/api/subagents/parallel-runs/:id` | Get parallel run |
| POST | `/api/subagents/parallel-runs/:id/cancel` | Cancel parallel run |

## Known Limitations

- **In-memory lock store**: Locks are not persisted across server restart (only audit is persisted)
- **No TUI force-release action**: Force release requires confirmation via CLI (`ara locks force-release <id> --reason "..."`)
- **No granular shell locks**: Mutating shell commands acquire a workspace-level write lock, blocking all concurrent mutations
- **Keyword-based mutation detection**: `isMutatingCommand()` uses keyword matching — may have false positives/negatives
- **Lock integration is optional via lazy import**: If `@ara/locks` import fails at runtime and `ARA_ALLOW_LOCK_FALLBACK=1` is not set, mutating tools are blocked
