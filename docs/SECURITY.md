# 🛡️ Ara Security & Sandboxing Architecture

Ara is designed to manage local host operations autonomously. Because personal assistants can be exposed to arbitrary tools or user inputs, Ara adopts a **Zero-Trust Multi-Layer Security Architecture**.

---

## 🔒 1. Multi-Tier Approval Gate
- **Safe Tier (`safe`):** Read-only tools (`list_files`, `read_file`, `git_status`, `git_diff`) execute immediately without user interruption.
- **Write Tier (`write`):** File modification operations (`write_file`) prompt the user with an explicit approval request on the Web dashboard before the file is actually modified.
- **Dangerous Tier (`dangerous`):** Subprocess shell command execution (`run_shell`) is strictly gated. The worker or API agent loop completely pauses until the user verifies and approves the command layout.

---

## 🔍 2. Credentials & Secrets Scanner
Before any tool execution, Ara parses the input using a robust regular expression scanner:
- **API Keys Scanned:** Detects OpenAI keys (`sk-`), Google API keys (`AIza-`), Slack tokens (`xox-`), and generic password variables assignments.
- **Action:** If a matching token is found, a **Safety Block** is triggered immediately, returning an error response to the agent, refusing to execute the shell command, and logging a security violation trace in the audit logs.

---

## 📂 3. Path Traversal & Workspace Isolation
To prevent the agent from escaping the workspace and modifying sensitive operating system files:
- **Absolute Resolution:** Every file tool strictly resolves target paths against the registered current working directory (`cwd`) using absolute resolution.
- **Constraint validation:**
  ```typescript
  if (!resolved.startsWith(path.resolve(cwd))) {
    throw new Error('Access denied: Cannot access files outside workspace.');
  }
  ```
  Any attempt to execute relative paths like `../../` outside the workspace triggers an instant abort.

---

## 🐳 4. Docker Sandbox Isolation
When `USE_DOCKER_SANDBOX=true` is enabled in the `.env` file, Ara wraps all shell executions inside an ephemeral Alpine Docker container:
- **Isolation:** Subprocesses run in an isolated Linux kernel container.
- **Directory mount:** Only the target sandbox workspace folder is mounted. The agent cannot touch other disks, hosts devices, or local networks.
- **Secrets protection:** No host environment variables are passed to the container workspace.

---

## 📁 5. Folder Backpoints Checkpointing
Before any file is written or overwritten:
- **Automatic backup:** A compressed copy of the original file is stored under `.ara/backups/` inside the workspace directory, appended with the exact millisecond timestamp.
- **Rollback safety:** If a linter error or build failure occurs, the original files are recoverable.
