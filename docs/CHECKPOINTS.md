# 🔒 Ara Checkpoints & Rewind UX Guide

Ara provides a reliable, local-first safety and checkpoint system designed to allow users to inspect workspace modifications, preview file diffs, and safely rewind code or chat history at any time.

---

## 📂 Storage Architecture

All checkpoints are saved in the local `.ara/checkpoints/` storage directory:
- **`metadata.json`**: An index file listing all created checkpoints, reasons, creators, timestamps, git commits, and related metadata.
- **`checkpoints/<id>/`**: A separate subdirectory for each checkpoint, containing snapshotted files and a snapshot of the chat conversation session.

---

## ⚡ File Snapshot & Selective Scrubbing Algorithm

To keep snapshots highly efficient, safe, and compact, the checkpoint engine uses a robust screening filter:
1. **Size Limits**: Any files larger than 1MB are automatically skipped.
2. **Secrets Scrubbing**: File names matching high-risk credentials patterns (e.g., `.env`, `id_rsa`, `.pem`, `credentials.json`) are strictly skipped to prevent credential exposure in snapshots.
3. **Binary Ignoring**: Binary file buffers (non-text contents) are filtered and skipped.
4. **Skipped Registry**: All skipped files are listed in the checkpoint details and visualized under the CLI/TUI interface.

---

## 🔄 The Three Restore Modes

When restoring a checkpoint, Ara offers fine-grained restoration to avoid destroying unrelated user progress:

| Mode | Target | Description |
| :--- | :--- | :--- |
| **`code_only`** | Workspace Files | Restores code files to their exact state at checkpoint creation. Ignores chat messages. |
| **`conversation_only`** | Chat Messages | Restores the conversation state in the database to the message count at snapshot. Ignores file changes. |
| **`both`** | Code & Chat | Fully rewinds both workspace files and chat message history simultaneously. |

---

## ⚙️ Trigger Locations & Automation

Checkpoints are automatically or manually triggered across the Ara Control Plane:

- **Automatic Before Mutating Tools**: Before any mutating file-edit or approved command execution (like `write_file` or running a shell script), Ara automatically creates an automated safety checkpoint.
- **Pre-Restore Automatic Checkpoint**: Before restoring any checkpoint `id`, Ara creates a `before_restore_<id>` safety checkpoint. This ensures you can *always* undo a rewind if needed!
- **Manual Triggers**: Users can trigger checkpoints manually using the REST API or CLI command tools.

---

## 🖥️ Safe Checkpoint UX Workflow

Ara provides an interactive, beautiful console UX inside the CLI/TUI:

1. **Dashboard Tab**: Press `Tab` or type tab shortcut to open the `[Checkpoints]` tab.
2. **Checkpoints Sidebar**: View all safety snapshots listed chronologically.
3. **Interactive Keys**:
   - `↑/↓`: Navigate through checkpoints.
   - `C` / `V` / `B`: Toggle between `code_only`, `conversation_only`, and `both` restore modes.
   - `R`: Trigger the double-frame red alert **Restore Confirmation Modal**.
4. **Workspace Diffs**: Inspect diff changes relative to the selected checkpoint on the right panel before restoring.
5. **Confirmation Action**: Type `Y` inside the modal to approve the restore, or press `N`/`Esc` to cancel.
