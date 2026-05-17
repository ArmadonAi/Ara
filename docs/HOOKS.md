# 🪝 Ara native safe lifecycle hooks system

Ara's Native Safe Lifecycle Hooks System provides a robust mechanism to hook custom automation, validation policies, and external checks directly into the agent runtime loop. Inspired by production-grade agent lifecycle concepts, it is tailored specifically for the Ara personal control plane with first-class local security defaults.

---

## 📅 Supported Lifecycle Events

Ara implements six precise, highly descriptive lifecycle hooks:

| Event Name | Insertion Point | Potential to Block | Typical Use Case |
|---|---|---|---|
| `SessionStart` | Triggered exactly when a new session starts (before any assistant generations) | **Yes** (Blocks session startup) | Workspace sanity check, git checkout validation |
| `UserPromptSubmit` | Fired when the user sends a message to the agent | **Yes** (Blocks user prompt submission) | Prompt filtering, safety check, input auditing |
| `PreToolUse` | Executed directly before any tool is run (after JSON validation, before permission checks) | **Yes** (Bypasses tool execution entirely) | Pre-validation check, dependency checks, mock returns |
| `PostToolUse` | Fired when a tool returns `success: true` | **No** (Informational only) | Automated test execution, state tracking, log sync |
| `ToolFailed` | Triggered when a tool runs but fails (`success: false` or throws) | **No** (Informational only) | Debug logs recovery, automatic error report generation |
| `SessionEnd` | Fired at the end of the streaming generation loop | **No** (Informational only) | Automated linting, workspace health summaries |

---

## 🔒 Security & Sandboxing Constraints

To protect sensitive information and keep the developer's system safe, the Hooks system enforces three critical layers of protection:

1. **Scrubbed Environment Stdin Context**: When dispatching command-line hooks, Ara feeds JSON metadata to the process via `stdin`. To prevent credential leaks, all system environment variables are completely scrubbed; hooks do not receive host credentials or secrets unless explicitly allowed.
2. **Permission Engine Validation**: Hook command execution relies directly on the **Permission Engine**. If a hook attempts to run a shell command or path that is denied or requires approval, the Permission Engine halts the hook, log-audits the block, and cleanly falls back to a safe block decision.
3. **Timeouts & Output Limits**: 
   - **Timeout Protection**: The maximum run duration is capped strictly at `3000ms`. If a hook hangs, it is killed automatically to prevent infinite blocking.
   - **Output Truncation**: A buffer limit of `50KB` is enforced on hook command outputs, saving Ara from memory bloat when dealing with massive log outputs.

---

## ⚙️ Configuration Schema (`.ara/settings.json`)

Hooks are configured inside `.ara/settings.json` (or falling back to `~/.ara/settings.json`) using the following structure:

```json
{
  "hooks": [
    {
      "name": "git-clean-check",
      "type": "command",
      "events": ["SessionStart"],
      "command": "git diff --quiet",
      "timeoutMs": 2000
    },
    {
      "name": "notify-slack",
      "type": "http",
      "events": ["PreToolUse"],
      "url": "https://api.slack.com/services/hooks/ara",
      "timeoutMs": 1500
    }
  ]
}
```

### Zod Validation Schema

All hooks configurations match the strict `@ara/hooks` Zod validation suite:
- **Command Hook Schema**: Validates standard string commands, matching `timeoutMs` bounds and event type lists.
- **HTTP Hook Schema**: Ensures valid URL string formats, custom hook event lists, and timeout configurations.

---

## 🛠️ CLI & TUI Interface

Ara exposes dedicated commands to monitor, validate, and debug lifecycle hooks directly from the terminal:

### 1. CLI Commands

* **`ara hooks`**: List all active hooks matching each lifecycle event, as well as configuration locations and diagnostic warnings.
* **`ara hooks validate`**: Validate current settings file against schemas:
  ```bash
  ara hooks validate
  ```
* **`ara hooks test <event>`**: Dispatches a mock trigger to test event hook execution:
  ```bash
  ara hooks test PreToolUse
  ```

### 2. Interactive Slash Commands

Within the TUI or interactive chat interface, developers can run:
* **`/hooks`**: Renders all registered hooks and active events inline.
* **`/hooks validate`**: Dry-run validates configuration schema alignment.

---

## 🌐 API Integrations

The Hono backend (`apps/api`) exposes the following endpoints:

* **`GET /api/hooks`**: Fetch list of active hooks and diagnostic alerts.
* **`GET /api/hooks/config`**: Retrieve the complete parsed JSON structure.
* **`POST /api/hooks/validate`**: Dry-run validate custom settings JSON payloads.
* **`POST /api/hooks/test`**: Mock-dispatch a lifecycle event with a dummy payload context.
