# Ara: Personal AI Control Plane (v0.1-RC1)

Ara is a secure, local-first personal AI assistant and autonomous workspace control plane. Developed as an integrated monorepo workspace, Ara delivers a high-integrity runtime environment featuring web dashboards, terminal interfaces, fine-grained safety policies, and an extensible lifecycle hooks architecture designed for robust developer productivity.

---

## Key Capabilities

* **Web Control Dashboard**: A high-performance dashboard featuring SSE streaming, real-time typing, collapsible thought logs, and interactive tool-execution monitoring.
* **CLI/TUI Gateway**: A responsive command-line interface and fullscreen terminal user interface built with Commander.js and React Ink.
* **ReAct Agent Runtime**: An autonomous planning and execution agent loop that leverages tool calling and dynamic feedback digestion.
* **Permission Engine**: A policy-driven access controller managing execution permissions before the approval gate. Evaluates operations as Allow, Ask, or Deny based on path safety, symlink integrity, and command risk assessment.
* **Lifecycle Hooks System**: Integrates hooks (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `ToolFailed`, `SessionEnd`) for custom automation, workspace sanity verification, and continuous integration validations.
* **Git Checkpointing & Backups**: Automatically backs up files and workspace states to `.ara/backups/` before any modifications are executed.
* **Local Memory & Skill Systems**: Progressive markdown loaders that dynamically rank facts, parse YAML frontmatter metadata, and integrate procedural skill guidelines.

---

## Monorepo Workspace Structure

```
apps/
  ├── web/           # React / Vite / TypeScript Dashboard UI
  ├── api/           # Hono REST API / SSE Chat Gateway & DB Controller
  ├── worker/        # Background Cron Scheduler & Automation Worker
  └── cli/           # CLI & fullscreen Terminal UI (TUI) binary gateway

packages/
  ├── shared/        # Shared core interfaces, Types & Zod Schemas
  ├── agent-core/    # ReAct Loop Orchestrator & System Prompters
  ├── tools/         # Filesystem, Git, and Sandboxed Shell tool sets
  ├── memory/        # Local Markdown USER.md / MEMORY.md storage parser
  ├── skills/        # YAML Frontmatter progressive SKILL.md loader
  ├── permissions/   # Policy evaluation, symlink checks, path safety filters
  ├── hooks/         # Lifecycle hooks executor, timeout constraints, HTTP/Command runners
  └── model-router/  # Cloud & Offline Provider Adapters (Gemini, OpenAI, Anthropic, Ollama)
```

---

## Installation and Setup

### 1. Prerequisites
Ensure that [Bun](https://bun.sh) is installed on your system.

### 2. Dependency Installation
Run the following command at the monorepo root to link workspace packages and resolve dependencies:
```bash
bun install
```

### 3. Environment Configuration
Copy the template configuration file:
```bash
cp .env.example .env
```
Populate the environment variables inside `.env` with your API credentials:
```ini
GEMINI_API_KEY=AIza...
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=xox-...
OLLAMA_HOST=http://127.0.0.1:11434
USE_DOCKER_SANDBOX=false
```

---

## Workspace Commands

| Command | Description |
|---|---|
| `bun run dev` | Run Web UI, Hono API, and background Worker concurrently |
| `bun run dev:web` | Start only the React Vite Frontend development server |
| `bun run dev:api` | Start only the Hono REST API backend |
| `bun run dev:worker` | Start only the Background Cron worker |
| `bun run dev:cli` | Execute direct CLI gateway options |
| `bun run build` | Build production assets across all workspace applications |
| `bun run build:cli` | Bundle the React Ink TUI binary and copy WASM runtime dependencies |
| `bun run typecheck` | Execute strict TypeScript compiler validation across the workspace |
| `bun run test` | Run the complete verification test suite |
| `bun run clean` | Purge build artifacts, distributions, and node_modules |

---

## CLI & Terminal User Interface (TUI)

Ara features a robust console interface. Detailed command listings, shortcuts, and configurations are documented in [docs/CLI.md](docs/CLI.md).

To register the executable globally:
```bash
bun link
```

### Supported Commands
```bash
ara status                        # Query current API and local metrics
ara tui                           # Open fullscreen interactive dashboard
ara chat "prompt"                 # Execute a one-shot query
ara approvals                     # List pending action execution approvals
ara approve <id>                  # Grant execution permissions
ara reject <id>                   # Block execution request
ara permissions                   # Retrieve current safety policy status
ara hooks                         # List configured workspace hooks
ara hooks validate                # Dry-run validate settings configuration
```

---

## Configuration Settings (`.ara/settings.json`)

Ara manages active lifecycle hooks, default rules, and runtime attributes via `.ara/settings.json` (falling back to `~/.ara/settings.json`).

### Configuration Schema Example
```json
{
  "hooks": [
    {
      "name": "workspace-integrity",
      "type": "command",
      "events": ["SessionStart"],
      "command": "git diff-index --quiet HEAD --",
      "timeoutMs": 3000
    },
    {
      "name": "notify-slack",
      "type": "http",
      "events": ["PreToolUse"],
      "url": "https://api.slack.com/services/hooks/ara",
      "timeoutMs": 2000
    }
  ]
}
```

* **Command Hook (`command`)**: Executes a local shell command. Stdin context is provided in JSON format, and the host environment is scrubbed for credential security. Exit code `2` or a non-zero code triggers a block decision.
* **HTTP Hook (`http`)**: Issues an asynchronous HTTP POST request carrying the lifecycle payload, returning control or decision block rules via structured JSON response.

---

## Security Model and Governance Policies

Ara is designed with security as a core architectural constraint:
1. **Multi-Tier Approvals**: Sensitive write and command shell operations are paused, yielding control until approved via the UI or CLI.
2. **Access Control (Permission Engine)**: Restricts tool execution according to configurable security modes. Enforces path confinement within the active workspace, blocking traversals and symlink escape vulnerabilities.
3. **Environment Scrubbing**: Prevents host credential leakage by purging system environment variables prior to executing command-line hooks.
4. **Shell Sanitization**: Automatically scans commands for exposed credential patterns (e.g., private keys, API secrets) and blocks execution immediately upon detection.
5. **Docker Isolation**: When sandbox execution is enabled, shell operations run inside a clean, ephemeral Alpine container.
