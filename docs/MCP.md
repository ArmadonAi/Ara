# MCP / External Tools

Ara integrates with the Model Context Protocol (MCP) to allow AI agents to discover and call external tools from configured MCP servers.

## Architecture

```
Agent proposes tool call (mcp.<serverId>.<toolName>)
  |
  v
Ara Tool Registry (ToolRegistry.get)
  |
  v
MCPToolAdapter.run() — Safety Pipeline:
  1. Permission Engine (evaluatePermission)
  2. PreToolUse hooks
  3. Checkpoint (if mutating)
  4. MCP Client (callTool)
  5. PostToolUse / ToolFailed hooks
  6. Audit log (writeMCPAudit)
```

MCP tools are never called directly. Every call goes through the full safety pipeline.

## Config Format (`.ara/mcp.json`)

```json
{
  "servers": [
    {
      "id": "filesystem",
      "name": "Local Filesystem",
      "type": "stdio",
      "command": "node",
      "args": ["mcp-fs-server.js"],
      "cwd": ".",
      "enabled": true,
      "trusted": false,
      "permissionMode": "default",
      "allowedTools": [],
      "deniedTools": [],
      "env": {},
      "timeoutMs": 15000
    },
    {
      "id": "github",
      "name": "GitHub API",
      "type": "http",
      "url": "http://localhost:8765/mcp",
      "headers": {},
      "enabled": false,
      "trusted": false,
      "allowedTools": [],
      "deniedTools": ["delete_repo"]
    }
  ]
}
```

### Fields

| Field | Type | Default | Description |
|---|---|---|---|
| id | string | required | Unique server identifier |
| name | string | required | Display name |
| type | enum | required | `stdio` or `http` |
| command | string | - | stdio: command to spawn |
| args | string[] | [] | stdio: command arguments |
| cwd | string | "." | stdio: working directory |
| url | string | - | HTTP: endpoint URL |
| headers | object | {} | HTTP: request headers |
| enabled | boolean | true | Enable/disable server |
| trusted | boolean | false | Trusted servers bypass ask gate |
| permissionMode | enum | "default" | `plan`, `default`, `accept-edits`, `auto-safe`, `danger-review` |
| allowedTools | string[] | [] | Allowlist (empty = all allowed) |
| deniedTools | string[] | [] | Denylist |
| env | object | {} | Environment variables (strict - no full process.env) |
| timeoutMs | number | 15000 | Request timeout |

## Transports

### stdio

Spawns a child process with the configured command/args. Communication uses JSON-RPC 2.0 over line-delimited stdin/stdout.

- `env` is strictly scoped to only explicitly listed variables
- Process is managed by MCPClient (`Bun.spawn`)
- Timeout configurable per-server

### HTTP

Makes JSON-RPC 2.0 POST requests to the configured URL.

- Uses `fetch()` with AbortController timeout
- Custom headers supported (e.g., for auth tokens)
- URL is not automatically validated at config parse time

## Server Lifecycle

1. **stopped** — Initial state after config load
2. **starting** — `startServer()` called, initializing connection
3. **healthy** — Server connected, tools discovered
4. **unhealthy** — Health check failed
5. **error** — Connection error or runtime failure
6. **disabled** — Server disabled in config, cannot be started

`startServer()` auto-discovers tools on connect. `discoverTools()` is an alias for `startServer()`.

## Safety Pipeline

### Permission Mapping

Evaluation order (enforced in `mapPermission`):

1. Server disabled → **deny**
2. Tool in `deniedTools` → **deny**
3. Secret patterns in name/input (untrusted only) → **deny**
4. Not in `allowedTools` (non-empty allowlist) → **deny**
5. Shell-like tool (run, exec, shell, etc.) on untrusted → **deny**
6. Write/mutating tool on untrusted → **ask**
7. Network tool on untrusted → **ask**
8. File tool on untrusted → **ask**
9. Trusted server → **allow**
10. Mode-based default

### Trust Levels

- **trusted** (`"trusted": true`): All tools allowed (after hard denies). Use for local, verified MCP servers.
- **untrusted** (`"trusted": false`): Tools evaluated individually. Write/dangerous tools ask for approval. Shell tools denied.

### Permission Modes

Same as Ara Permission Engine:

| Mode | Behavior |
|---|---|
| `default` | Untrusted tools ask; safe tools pass |
| `plan` | All external tools require approval |
| `accept-edits` | Non-mutating tools allowed; mutating asks |
| `auto-safe` | Only safe tools allowed |
| `danger-review` | All external tools require approval |

### Audit Redaction

All MCP audit records are redacted for API keys:

- OpenAI keys (`sk-...`): redacted
- Anthropic keys (`sk-ant-...`): redacted
- Google API keys (`AIza...`): redacted
- GitHub PATs (`ghp_...`): redacted
- GitLab PATs (`glpat-...`): redacted

## Tool Registry Integration

Discovered MCP tools are adapted as Ara `Tool` objects and registered in the global `ToolRegistry`:

- **Name**: `mcp.<serverId>.<toolName>`
- **Description**: `[MCP / <serverName>] <tool description>`
- **Input Schema**: Converted from JSON Schema to Zod
- **Danger Level**: Inferred from tool name (mutating keywords → `write`, else `safe`)
- **requiresApproval**: Set based on `dangerLevel`

### Mutating Heuristic

A tool is considered mutating if its name contains:
`write`, `edit`, `delete`, `create`, `update`, `patch`, `apply`, `commit`, `push`, `merge`, `move`, `rename`, `upload`, `run`, `exec`, `shell`, `command`, `install`, `build`

### Checkpoint Integration

Before any mutating MCP tool call, the system creates a checkpoint if the `@ara/checkpoints` module is available. Read-only MCP tools do not create checkpoints.

### Hooks Integration

MCP tool calls fire the standard Ara lifecycle hooks:

- `PreToolUse` — Before tool execution
- `PostToolUse` — After successful execution
- `ToolFailed` — On execution failure

Additionally, MCP lifecycle events are available as hook event types:

- `MCPServerStart`
- `MCPServerStop`
- `MCPToolDiscovered`
- `MCPToolCallStart`
- `MCPToolCallEnd`
- `MCPToolCallFailed`

## API Routes

| Method | Path | Description |
|---|---|---|
| GET | `/api/mcp` | MCP overview with health summary |
| GET | `/api/mcp/servers` | List all configured servers |
| GET | `/api/mcp/servers/:id` | Get server details with tools |
| GET | `/api/mcp/servers/:id/tools` | List tools for a specific server |
| POST | `/api/mcp/servers/:id/start` | Start a server |
| POST | `/api/mcp/servers/:id/stop` | Stop a server |
| POST | `/api/mcp/servers/:id/restart` | Restart a server |
| GET | `/api/mcp/tools` | List all discovered tools across servers |
| POST | `/api/mcp/tools/:fullToolName/call` | Call a tool through the safety pipeline |
| POST | `/api/mcp/tools/refresh` | Refresh tools for all running servers |
| POST | `/api/mcp/servers/:id/tools/refresh` | Refresh tools for one server |
| POST | `/api/mcp/servers/:id/reconnect` | Reconnect a failed server |
| GET | `/api/mcp/health` | Health check all servers |
| POST | `/api/mcp/config/validate` | Validate MCP config format |
| GET | `/api/mcp/audit` | List MCP audit records |

### Tool Call Endpoint

`POST /api/mcp/tools/:fullToolName/call`

Input: `{ "sessionId": "...", "input": { ... } }`

Safety checks enforced:
- Disabled server → **deny**
- Unknown tool → **deny**
- Permission Engine evaluation
- Checkpoint creation for mutating tools
- PreToolUse / PostToolUse hooks
- Audit log entry

Returns `{ "awaitingApproval": true }` if the tool requires human approval.

## CLI Commands

```bash
# List servers
ara mcp servers

# Show server details
ara mcp server <id>

# Start/stop/restart
ara mcp start <id>
ara mcp stop <id>
ara mcp restart <id>

# Reconnect a failed server
ara mcp reconnect <id>

# Refresh tools (specific server or all running)
ara mcp refresh <serverId>
ara mcp refresh

# List tools (all or per-server)
ara mcp tools
ara mcp tools <serverId>

# Call a tool through safety pipeline
ara mcp call mcp.fs.read_file --json '{"path":"README.md"}'

# Health check
ara mcp health

# Validate config format
ara mcp validate '{"servers":[]}'
```

## Slash Commands

```
/mcp servers                  — List servers
/mcp tools [serverId]         — List tools
/mcp health                   — Health check
/mcp start <id>               — Start server
/mcp stop <id>                — Stop server
```

## TUI Tab

The MCP tab in the TUI dashboard shows:
- Configured servers with enabled/disabled status
- Trust level and permission mode per server
- Discovered tools per server
- Health status summary
- Audit event counters

Actions: start, stop, restart (with confirmation).

## Persistent Audit

MCP audit records are stored in `.ara/audit/mcp.jsonl` (append-only JSONL) for persistence across server restarts. An in-memory cache of the last 1000 records provides fast queries.

- Records are never deleted from the file
- `clearMCPAudit()` clears only the in-memory cache
- `clearAuditFile()` clears both cache and file (test utility)
- `reloadAuditFromDisk()` rebuilds cache from the file

## Tool Refresh

Tools can be refreshed without restarting the server:

- `refreshTools(serverId)` — re-initializes a running server's client and updates tool list
- `refreshAllTools()` — refreshes all running servers
- Removed tools are detected and marked unavailable
- Tool Registry registrations are updated automatically
- Disabled/stopped servers are NOT started by refresh

## Health States

| State | Description |
|---|---|
| `healthy` | Protocol ping succeeded |
| `degraded` | Process alive but ping failed |
| `unhealthy` | Process dead or unreachable |
| `stopped` | Manually stopped |
| `disabled` | Disabled in config (cannot start) |

Health check performs active protocol-level ping (JSON-RPC `ping` method). For stdio, falls back to process liveness check if ping times out.

## Reconnection

Failed servers can be reconnected via `POST /api/mcp/servers/:id/reconnect` or `ara mcp reconnect <id>`.

Behavior:
- Stops the client (cleans up process/resources)
- Creates a fresh client connection
- Re-initializes and discovers tools
- Updates Tool Registry registrations
- Reconnect is denied for disabled servers
- Reconnect is denied for healthy servers (use refresh instead)

## Subagent Allowlist Enforcement

Subagents may use MCP tools only if:
- Profile's `tools` array includes the exact MCP tool name (e.g. `mcp.github.get_issue`)
- Or profile includes namespace wildcard (e.g. `mcp.github.*` matches any `mcp.github.X` tool)
- Tool is read-only (`dangerLevel` is `safe` or `network`)
- Permission Engine allows it

Subagents cannot:
- Start/stop/restart MCP servers (API endpoint enforced)
- Call mutating MCP tools (`write` or `dangerous`)
- Self-approve `ask` decisions (parent/user approval required)

Wildcard support in subagent profile `tools` array:
```json
{
  "tools": ["mcp.github.*", "mcp.filesystem.read_file"]
}
```

## Limitations (v0.1)

- **No server auto-discovery**: Servers must be listed in `.ara/mcp.json`
- **No streaming tool calls**: Tools execute synchronously
- **No client pool**: One client per server config
- **stdio ping fallback**: If MCP server doesn't support `ping` method, stdio falls back to process liveness check
- **No SQLite audit**: Audit uses JSONL files, not SQLite tables
