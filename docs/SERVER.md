# Ara Server Runtime

Local process management for the Ara runtime (API, Web, Worker).

## Quick Start

```bash
# Start API server in background (default)
ara server start

# Start with Web UI
ara server start --with-web

# Start with watchdog (auto-restart on crash)
ara server start --with-web --watchdog

# Start in foreground (logs stream to terminal)
ara server start --foreground

# Check status
ara server status

# View logs
ara server logs

# Stop
ara server stop
```

## Commands

### `ara server` / `ara server status`

Show current runtime status — processes, PIDs, ports, health, uptime, restart count, log sizes.

```
  Ara Server Runtime Status
  ──────────────────────────────────────────────────────────
  ● API     pid=4564 port=3001 http://localhost:3001
     health=healthy uptime=2h 15m logs=1.2 MB
  ● Worker  pid=4565
     health=healthy uptime=2h 15m logs=340.0 KB
  ○ Web     pid=-
     health=unknown uptime=- logs=0 B
  ──────────────────────────────────────────────────────────
  Started:    1/15/2025, 10:30:45 AM
  Uptime:     2h 15m
  Restarts:   0
  Watchdog:   off
  Config:     default
  State dir:  /path/to/project/.ara/server
```

### `ara server start`

Start Ara server processes.

| Option | Default | Description |
|---|---|---|
| `--api-only` | false | Start only the API server |
| `--with-web` | false | Start the Web UI dev server |
| `--with-worker` | true | Start the background worker |
| `--api-port <port>` | 3001 | API server port |
| `--web-port <port>` | 5173 | Web UI dev server port |
| `--detached` | true | Run in background |
| `--foreground` | false | Stream logs to terminal, Ctrl+C to stop |
| `--watchdog` | false | Enable auto-restart on crash |

Default behavior starts **API + Worker**. Web and watchdog are optional.

When `--watchdog` is enabled, the server monitors all processes every 5 seconds.
If a process crashes, it is automatically restarted with exponential backoff
(1s, 2s, 4s, 8s, 16s, max 30s) up to the configured restart limit.

### `ara server stop [target]`

Stop processes. Without arguments, stops all (worker → web → API).

```bash
ara server stop          # Stop all
ara server stop api      # Stop API only
ara server stop web      # Stop Web only
ara server stop worker   # Stop Worker only
```

Uses graceful SIGTERM first, waits up to 5 seconds, then force kills. On Windows,
`taskkill /F` is used as a reliable fallback.

### `ara server restart`

Stop all processes then start again. Accepts `--with-web`, `--api-port`, `--web-port`, `--watchdog`.

### `ara server logs`

View process logs.

```bash
ara server logs                    # All logs (last 50 lines)
ara server logs --api              # API logs only
ara server logs --web              # Web logs only
ara server logs --worker           # Worker logs only
ara server logs --lines 100        # Show last 100 lines
ara server logs --follow           # Show tail -f commands to follow
```

Shows log file size next to each source. Secrets are automatically redacted:
`sk-*`, `sk-ant-*`, `ghp_*`, `github_pat_*`, `Authorization: Bearer`.

### `ara server open`

Open Web UI in default browser. If Web is not running, prints the start command.

### `ara server prune-logs`

Remove rotated log files beyond the configured retention count, and trim
oversized current logs (keeps last 10,000 lines if > 5 MB).

```bash
ara server prune-logs              # Prune all logs
ara server prune-logs --api        # Prune API logs only
ara server prune-logs --web        # Prune Web logs only
ara server prune-logs --worker     # Prune Worker logs only
```

### `ara server clean`

Remove stale PID files, rotated logs, and server state file. Does not touch
running processes or current logs.

```bash
ara server clean
```

### `ara server doctor`

Diagnose server state, config, logs, and processes.

```
  Ara Server Diagnostics
  ──────────────────────────────────────────────────────────
  ✓ .ara/server/ exists
  ✓ .ara/server/logs/ writable
  i   api.log: 1.2 MB
  i   Config: file (apiPort=3001, logMaxBytes=10.0 MB, watchdog=false)
  ✓ api running (pid 4564)
  i   web: no PID file
  ✓ worker running (pid 4565)
  ✓ server.json valid
  i   Uptime: 2h 15m
  i   Restarts: 0
  ✓ Port 3001 (API) available
  ✓ Port 5173 (Web) available
  i   Total log size: 1.5 MB
  ──────────────────────────────────────────────────────────
  8 passed, 0 failed, 5 info
```

## Configuration

Server settings are stored in `.ara/server/config.json`. Created automatically
on first `ara server start` with flag values.

```json
{
  "apiPort": 3001,
  "webPort": 5173,
  "withWeb": false,
  "withWorker": true,
  "logMaxBytes": 10485760,
  "logMaxFiles": 3,
  "watchdogEnabled": false,
  "restartLimit": 3
}
```

| Field | Default | Description |
|---|---|---|
| `apiPort` | 3001 | API server port |
| `webPort` | 5173 | Web dev server port |
| `withWeb` | false | Start Web UI by default |
| `withWorker` | true | Start worker by default |
| `logMaxBytes` | 10485760 (10 MB) | Log file size before rotation |
| `logMaxFiles` | 3 | Number of rotated log files to keep |
| `watchdogEnabled` | false | Auto-restart on crash |
| `restartLimit` | 3 | Max restart attempts per process |

Edit the file directly or pass flags to `ara server start` (flags override config).

## Foreground vs Detached

| Mode | Behavior |
|---|---|
| **Detached** (default) | Processes run in background. Logs go to `.ara/server/logs/`. Use `ara server stop` to stop. |
| **Foreground** (`--foreground`) | Logs stream to terminal. Press Ctrl+C to stop all processes. |

## Watchdog (Auto-Restart)

When `--watchdog` is enabled:

- Checks process health every 5 seconds
- Restarts crashed processes automatically
- Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
- Stops after configured `restartLimit` attempts per process
- Restart events are logged to the process log file
- Server status tracks restart count and last crash time

## Log Rotation

Logs are rotated automatically when they exceed `logMaxBytes` (default 10 MB).

- Current log → `api.log.1`, old `api.log.1` → `api.log.2`, etc.
- Up to `logMaxFiles` rotated files are kept (default 3)
- Older rotated files can be pruned with `ara server prune-logs`
- Large logs (> 5 MB) are trimmed to 10,000 lines during pruning

## Runtime State Directory

```
.ara/server/
├── config.json      # Server configuration
├── api.pid          # API process PID
├── web.pid          # Web process PID (if started)
├── worker.pid       # Worker process PID (if started)
├── server.json      # Full runtime state (JSON)
└── logs/
    ├── api.log      # API server stdout/stderr
    ├── api.log.1    # Rotated API log
    ├── web.log      # Web dev server stdout/stderr
    ├── worker.log   # Worker stdout/stderr
    └── ...
```

### server.json

```json
{
  "startedAt": "2025-01-01T10:30:45.000Z",
  "processes": {
    "api": {
      "running": true,
      "pid": 4564,
      "port": 3001,
      "url": "http://localhost:3001",
      "health": "healthy"
    },
    "web": { "running": false, "health": "unknown" },
    "worker": {
      "running": true,
      "pid": 4565,
      "health": "healthy"
    }
  },
  "uptime": "2h 15m 30s",
  "restartCount": 0,
  "lastCrash": null,
  "watchdogEnabled": false,
  "configSource": "file",
  "logSizes": {
    "api": 1234567,
    "web": 0,
    "worker": 340000
  }
}
```

## Health Checks

| Target | Method |
|---|---|
| API | `GET /api/status` — HTTP 200 = healthy |
| Web | `GET /` — HTTP 200 = healthy |
| Worker | Process liveness (PID check) |

Health is checked on `ara server status`. If a process is running but not responding, it shows as `unhealthy`.

## Port Management

Before starting, `ara server start` checks:
1. If the port is already in use by Ara (reuses existing PID)
2. If the port is in use by another process (shows readable error)
3. Stale PID files are cleaned up automatically

## Doctor Integration

`ara doctor` (top-level) and `ara server doctor` check:
- `.ara/server/` directory exists
- `.ara/server/logs/` is writable
- PID files and whether processes are running or stale
- `server.json` validity
- Config source and values
- Port 3001 (API) and 5173 (Web) availability
- Log file sizes

## Troubleshooting

### Stale PID files

If Ara crashes without running `ara server stop`, stale PID files may remain.
Run `ara server start` — it cleans stale PIDs automatically.
Or run `ara server doctor` to detect stale PIDs.

### Port already in use

```bash
ERROR: Port 3001 is in use by another process.
Choose a different port with --api-port <port>
```

Check what's using the port:
```bash
# Windows
netstat -ano | findstr :3001

# macOS/Linux
lsof -i :3001
```

### Worker not starting

The Worker requires API to be running (it connects to the database). The Worker failure is non-fatal — API and Web still work.

### Log files growing large

Logs are rotated automatically at 10 MB. Use `ara server prune-logs` to clean old
rotated files and trim oversized logs. Configure retention with `logMaxBytes` and
`logMaxFiles` in `.ara/server/config.json`.

### Process crash loop

If a process crashes repeatedly with watchdog enabled, it stops after the
configured `restartLimit` (default 3). Check `ara server status` for restart count
and last crash time. Use `ara server logs --api` to investigate the cause.

## Windows Notes

- Process spawning uses `Bun.spawn` with `detached: true`
- SIGTERM is supported on Windows (Bun translates it)
- Force kill uses `taskkill /F` as reliable fallback
- Port checking uses `Bun.listen` attempt
- Log files use the same format as Linux/macOS
- PID files contain Windows process IDs

## Known Limitations

- **No log rotation on Windows**: Bun's `fs.renameSync` may fail if log file is still open
- **No centralized log aggregation**: Logs are stored in separate files per process
- **Single instance**: Only one runtime per project directory
- **Web dependency**: Worker doesn't depend on Web, but Web depends on API
- **Watchdog is polling-based**: Checks every 5 seconds, not event-driven
