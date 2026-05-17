# 🖥️ Ara CLI & TUI Gateway Documentation

Ara provides a powerful terminal interface in `apps/cli` to control and interact with the Ara Control Plane directly from your command line. The interface supports a fullscreen interactive Terminal User Interface (TUI) and direct CLI commands that query the Ara API Server (`apps/api`).

---

## 🕹️ Monorepo Workspace Integration

The CLI package is integrated into the Bun workspaces under `@ara/cli` in `apps/cli`.
It uses React, Ink, Commander.js, and standard HTTP/SSE stream clients to interface with the backend.

### CLI Workspace Commands

| Command | Working Directory | Description |
|:---|:---|:---|
| `bun run dev:cli` | Root | Run the CLI source entry point directly |
| `bun run build:cli` | Root | Bundles the CLI app and copies compiled WASM assets |
| `bun run typecheck:cli` | Root | Typecheck the CLI codebase using `tsc --noEmit` |
| `bun run test` | Root | Run the complete monorepo test suite (including `apps/cli/tests/cli.test.ts`) |

---

## ⚙️ Configuration Manager

The CLI saves its local parameters at `~/.ara/config.json`. By default, the config file is created automatically on the first run with these default settings:

```json
{
  "apiBaseUrl": "http://localhost:3001",
  "theme": "default",
  "defaultModel": null,
  "defaultSessionId": null
}
```

To view or update your config directly from the CLI, use the `ara config` command:

* **View all configuration options**:

  ```bash
  ara config
  ```

* **Update specific key**:

  ```bash
  ara config apiBaseUrl http://localhost:3001
  ```

---

## 🕹️ CLI Command Reference

Once linked via `bun link`, you can invoke the CLI with `ara` directly:

### 1. Interactive TUI Dashboard

Open a premium fullscreen, Arrow/Tab controlled terminal dashboard with real-time SSE stream decoding and approval gate resolutions:

```bash
ara tui
# or simply
ara
```

### 2. Conversation Commands

* **Interactive Console Chat Loop**:

  ```bash
  ara chat
  ```

  Starts a readline prompt loop. Type your query, press Enter to view streaming replies, and type `exit` to quit.

* **One-Shot Streaming Prompt**:

  ```bash
  ara chat "What files are in this directory?"
  ```

  Sends a single prompt, streams the reply to stdout, and displays approval warnings if the agent encounters a risky tool gate.

* **List Chat Sessions**:

  ```bash
  ara sessions
  ```

  Lists previous conversation session IDs, title metadata, model profiles, and message counts.

* **View Chat History**:

  ```bash
  ara session <sessionId>
  ```

  Outputs the full chat transcript history for the specified session.

### 3. Risk Authorization & Approvals Gate

* **List Pending Approvals**:

  ```bash
  ara approvals
  ```

  Queries the SQLite database for pending high-risk tool operations that are blocked at the gate.

* **Approve Execution**:

  ```bash
  ara approve <approvalId>
  ```

  Authorizes the blocked tool to continue and outputs the execution response.

* **Reject Execution**:

  ```bash
  ara reject <approvalId>
  ```

  Blocks the tool, returns a rejection status to the agent loop, and resumes agent planning.

### 4. Checkpoints & Rewind

Checkpoints capture workspace file states and session transcript snapshots, enabling safe code and conversation rewind.

* **List all checkpoints**:

  ```bash
  ara checkpoints
  ```

  Displays a chronological list of all created checkpoints with their session ID, reason, timestamp, file count, and message count.

* **Create a manual checkpoint**:

  ```bash
  ara checkpoint create "Before major refactor"
  ```

  Spawns a named safety snapshot for the active session.

* **Show checkpoint details**:

  ```bash
  ara checkpoint show chk_a1b2c3d4
  ```

  Prints full metadata for the checkpoint including file list, git head, and message count.

* **Show diff from checkpoint**:

  ```bash
  ara checkpoint diff chk_a1b2c3d4
  ```

  Shows files that have been created, modified, or deleted since the checkpoint was taken. Files that were skipped (large, binary, or secrets) are listed at the bottom.

* **Restore to checkpoint**:

  ```bash
  ara restore chk_a1b2c3d4 --mode code_only
  ara restore chk_a1b2c3d4 --mode conversation_only
  ara restore chk_a1b2c3d4 --mode both
  ```

  Restores files, conversation, or both. **A pre-restore safety checkpoint is automatically created before the restore runs**, so you can always undo a rewind.

  | Mode | Files | Messages |
  |------|-------|----------|
  | `code_only` | Restored | Left as-is |
  | `conversation_only` | Left as-is | Rewound to snapshot |
  | `both` | Restored | Rewound to snapshot |

* **Rewind helper**:

  ```bash
  ara rewind
  ```

  Prints available checkpoints and suggests restore commands for quick rollback.

### 5. System Diagnostics & Healthchecks

* **Status Diagnostics**:

  ```bash
  ara status
  ```

  Retrieves database integrity checks, memory ingestion modes, and pending approval counts from the backend hono API server.

* **List Ephemeral Memories**:

  ```bash
  ara memory [query]
  ```

  Lists all episodic memory logs or searches for specific entries.

* **List Progressive Skills**:

  ```bash
  ara skills
  ```

  Lists all metadata parsed from markdown procedural skill sheets.

* **List Sandbox Tools**:

  ```bash
  ara tools
  ```

  Lists all sandboxed tool execution signatures currently registered in the sandbox.

* **Audit Logs Trace**:

  ```bash
  ara audit
  ```

  Outputs the recent list of immutable tool audit logs (with status and truncated responses).

---

## 🎮 TUI Layout Keyboard Shortcuts

When running the interactive TUI (`ara tui`), use the following key-bindings:

* **`Tab` / `Shift+Tab`**: Cycle between tabs (Chat ➔ Subagents ➔ Approvals ➔ Checkpoints ➔ Tools ➔ Memory ➔ Skills ➔ Audit ➔ Status).
* **`Up Arrow` / `Down Arrow`**: Scroll through items in the selected panel (sessions list, checkpoints list, approvals list, etc.).
* **`Ctrl+N`**: Create a new session.
* **`Ctrl+L`**: Clear current chat panel logs buffer.
- **`Ctrl+C`**: Close and exit the TUI dashboard.
* **`Enter`** (within Chat tab): Submit prompt typed in the bottom text box.
* **`A`** (within Approvals tab): Approve selected high-risk tool execution inline.
* **`R`** (within Approvals tab): Reject selected high-risk tool execution inline.

---

## 🛠️ Compilation and Asset Packaging

The TUI utilizes **Yoga Layout WASM** for computing flexbox constraints in raw ANSI terminals.
To bundle the sub-app securely without missing WASM modules:

1. Run `bun run build:cli` in the monorepo root.
2. The custom `build.ts` compiler compiles `src/main.tsx` using `bun build --target=bun` and dynamically locates `yoga.wasm` inside the cached `.bun` workspace modules to copy it into `dist/yoga.wasm`.
3. If the WASM file is deleted or cannot be resolved, a descriptive error message is output.
