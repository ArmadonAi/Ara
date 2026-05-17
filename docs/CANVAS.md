# Canvas / Workspace Nodes

Ara Canvas provides a visual workspace layer where chats, tasks, files, artifacts, memories, skills, subagents, GitHub objects, and MCP tools can be represented as nodes and connected into workflows.

## Data Model

### CanvasWorkspace

| Field | Type | Description |
|---|---|---|
| id | string | UUID |
| name | string | Display name |
| description | string? | Optional description |
| projectRoot | string | Workspace root directory |
| createdAt | string | ISO timestamp |
| updatedAt | string | ISO timestamp |

### CanvasNode

| Field | Type | Description |
|---|---|---|
| id | string | UUID |
| workspaceId | string | Parent workspace |
| type | enum | See node types below |
| title | string | Display title |
| description | string? | Optional description |
| position | { x, y } | Canvas position |
| data | object | Type-specific data (no secrets) |
| sourceRef | string? | Reference to source object (e.g. `file:src/index.ts`) |

### Node Types

| Type | Description | sourceRef format |
|---|---|---|
| chat | Chat session node | `session:<sessionId>` |
| session | Saved session reference | `session:<sessionId>` |
| task | Task node | `task:<taskId>` |
| file | File reference node | `file:<path>` |
| artifact | Artifact/output node | `artifact:<id>` |
| memory | Memory fact node | `memory:<memoryId>` |
| skill | Skill procedure node | `skill:<name>` |
| subagent | Subagent run node | `subagent_run:<runId>` |
| github_issue | GitHub issue reference | `github_issue:owner/repo#number` |
| github_pr | GitHub PR reference | `github_pr:owner/repo#number` |
| mcp_tool | MCP tool reference | `mcp_tool:<fullToolName>` |
| checkpoint | Checkpoint snapshot node | `checkpoint:<checkpointId>` |
| note | Free-form note node | — |

### CanvasEdge

| Field | Type | Description |
|---|---|---|
| id | string | UUID |
| workspaceId | string | Parent workspace |
| fromNodeId | string | Source node |
| toNodeId | string | Target node |
| type | enum | reference, dependency, result, action, context |
| label | string? | Edge label |

## Storage

Workspaces are persisted as individual JSON files:

```
.ara/canvas/workspaces/<workspace-id>.json
```

Each file contains `{ workspace, nodes[], edges[] }`.

## API Routes

| Method | Path | Description |
|---|---|---|
| GET | `/api/canvas/workspaces` | List workspaces |
| POST | `/api/canvas/workspaces` | Create workspace |
| GET | `/api/canvas/workspaces/:id` | Get workspace with nodes and edges |
| PATCH | `/api/canvas/workspaces/:id` | Update workspace |
| DELETE | `/api/canvas/workspaces/:id` | Delete workspace |
| POST | `/api/canvas/workspaces/:id/nodes` | Add node |
| PATCH | `/api/canvas/workspaces/:id/nodes/:nodeId` | Update node |
| DELETE | `/api/canvas/workspaces/:id/nodes/:nodeId` | Delete node |
| POST | `/api/canvas/workspaces/:id/edges` | Add edge |
| DELETE | `/api/canvas/workspaces/:id/edges/:edgeId` | Delete edge |
| POST | `/api/canvas/workspaces/:id/actions` | Execute action on node |
| GET | `/api/canvas/workspaces/:id/export` | Export workspace as JSON |
| GET | `/api/canvas/audit` | List canvas audit events |

## Safety Rules

- **Read actions** (`open_node`, `summarize_node`, `export_canvas`, `inspect_mcp_tool_node`): Run directly
- **Write actions** (`attach_node_to_chat`, `create_task_from_node`, `link_nodes`, etc.): Require Permission Engine + Approval Gate dispatch through API
- **File node mutation**: Must use file locks and checkpoints
- **GitHub write actions**: Must use GitHub tools and approval
- **MCP actions**: Must use MCP Tool Registry integration
- Nodes never store secrets (tokens, keys, credentials)

## Slash Commands

```
/canvas list               — List workspaces
/canvas create <name>      — Create workspace
/canvas show <id>          — Show workspace summary
/canvas export <id>        — Export workspace
```

## TUI Canvas Tab

The TUI Canvas tab shows:
- Workspace list with names, IDs, and creation dates
- Workspace count
- Command reference for CLI and slash commands
- Auto-refreshes every 5 seconds
- API offline state displayed clearly
- No secrets or sensitive data displayed

Keyboard: Tab to navigate to Canvas tab. Read-only display.

## Web UI

The Canvas page provides:
- Workspace list sidebar
- Create/delete workspaces
- Node grid display with color-coded types
- Node detail side panel
- Export JSON button
- Node count statistics by type

## CLI Commands

```bash
# List workspaces
ara canvas list

# Create workspace
ara canvas create "My Workspace" --description "Project notes"

# Show workspace with node/edge counts
ara canvas show <workspaceId>

# Delete workspace
ara canvas delete <workspaceId>

# Add a node
ara canvas add-node <workspaceId> --type file --title "src/index.ts" --ref "file:src/index.ts" --x 100 --y 200

# Update a node
ara canvas update-node <workspaceId> <nodeId> --title "New Title"

# Delete a node
ara canvas delete-node <workspaceId> <nodeId>

# Add an edge between nodes
ara canvas add-edge <workspaceId> <fromNodeId> <toNodeId> --type reference --label "depends on"

# Delete an edge
ara canvas delete-edge <workspaceId> <edgeId>

# Export workspace as JSON (prints to stdout)
ara canvas export <workspaceId>

# Export workspace to file
ara canvas export <workspaceId> --out workspace.json
```

## Slash Commands

```
/canvas create <name>    — Create workspace
/canvas add-file <path>  — Add file node
/canvas export           — Export current workspace
```

## Audit Events

- `canvas.workspace.created`
- `canvas.workspace.updated`
- `canvas.workspace.deleted`
- `canvas.node.created`
- `canvas.node.updated`
- `canvas.node.deleted`
- `canvas.edge.created`
- `canvas.edge.deleted`
- `canvas.action.executed`
- `canvas.exported`

## Export Behavior

- Without `--out`: prints JSON to stdout
- With `--out <file>`: writes JSON to file using `fs.promises.writeFile`
- File write uses ESM-compatible dynamic import

## Limitations (v0.1)

- **No drag-and-drop**: Nodes use absolute positioning via API; no visual canvas board with drag in v0.1
- **No live collaboration**: Single-user workspace only
- **No auto-layout**: Nodes must be positioned manually via position API
- **File-based storage**: Not SQLite; no relational queries across workspaces
- **Simple Web UI**: Basic grid display; no React Flow integration yet
- **TUI Canvas tab is read-only**: No node/edge management from TUI; use CLI
