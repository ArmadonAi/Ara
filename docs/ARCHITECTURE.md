# 🏛️ Ara System Architecture Specification

Ara is structured as a Bun-powered monorepo to isolate concerns, maintain performance, and provide a secure operating layer.

---

## 🧬 Monorepo Package Relationships

```
                        [ apps/web ] (Vite React SPA)
                             │
                             ▼ (REST / SSE)
                        [ apps/api ] (Hono API Server) <──> [ sqlite (ara.sqlite) ]
                             │
            ┌────────────────┴────────────────┐
            ▼                                 ▼
   [ packages/agent-core ]            [ apps/worker ] (Cron Scheduler)
            │
  ┌─────────┼─────────┬─────────────────────────┐
  ▼         ▼         ▼                         ▼
[shared] [tools]  [memory]                   [skills]
  ▲         ▲         ▲                         ▲
  │         │         │                         │
  └─────────┴─────────┴─────[model-router]──────┘
```

---

## 🔁 SSE ReAct Loop & Streaming Flow

When a user submits a message, Hono opens an SSE (Server-Sent Events) stream. The ReAct agent executes in an iterative loop:

1. **Context Building:** Retrieval is performed. Memory (from `memory/USER.md` and `memory/MEMORY.md`) and procedures (from `skills/*/SKILL.md`) are dynamically fetched and compiled into the system prompter.
2. **Model Call:** The compiled system prompt and messages history are streamed to the LLM provider router.
3. **Execution Planning:**
   - If the LLM generates a text message, it is yielded to the SSE stream.
   - If the LLM requests a tool call via `<tool_call name="...">JSON</tool_call>`, Hono intercepts the execution:
     - **Safe Tools (`list_files`, `read_file`):** Run immediately, results are appended back to history, and loop continues.
     - **Risky Tools (`write_file`, `run_shell`):** Hono creates a pending approval record in SQLite, outputs an `awaitingApproval` chunk, and **PAUSES** the agent's generator execution.
4. **Resuming turn:** Once the user clicks "Approve" on the dashboard, the tool runs, Hono appends the output to history, and calls the continuation endpoint to complete the agent's reasoning.

---

## 💾 Database Schema Spec

Ara utilizes `bun:sqlite` to manage sessions, logs, automations, and approvals:

### `sessions`
Represents isolated conversation chains.
- `id` (TEXT PRIMARY KEY)
- `title` (TEXT)
- `model` (TEXT)
- `created_at` (TEXT)
- `updated_at` (TEXT)

### `messages`
Maintains exact history records.
- `id` (TEXT PRIMARY KEY)
- `session_id` (TEXT, FK references sessions)
- `role` (TEXT: user, assistant, system)
- `content` (TEXT)
- `created_at` (TEXT)

### `approvals`
Holds records of all pending and resolved tools calls.
- `id` (TEXT PRIMARY KEY)
- `session_id` (TEXT, FK)
- `tool_name` (TEXT)
- `input` (TEXT - JSON formatted string)
- `risk_level` (TEXT: safe, write, dangerous)
- `reason` (TEXT)
- `status` (TEXT: pending, approved, rejected)
- `created_at` (TEXT)

### `audit_logs`
Immutable trace log of all tools requested.
- `id` (TEXT PRIMARY KEY)
- `session_id` (TEXT, FK)
- `tool_name` (TEXT)
- `input` (TEXT)
- `output` (TEXT)
- `status` (TEXT: success, failed)
- `created_at` (TEXT)

### `automations`
Stores automation schedules and triggers.
- `id` (TEXT PRIMARY KEY)
- `name` (TEXT)
- `cron` (TEXT)
- `prompt` (TEXT)
- `enabled` (INTEGER)
- `last_run` (TEXT)
- `created_at` (TEXT)
