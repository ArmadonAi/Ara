# ⏰ Ara Automation & Background Cron Scheduler

Ara features a completely independent automation background system that handles scheduled jobs, prompt scripts, and system maintenance tasks automatically.

---

## 🏗️ Worker Lifecycle (`apps/worker`)

The worker daemon runs in a zero-dependency autonomous loop:

```
[ Worker Start ]
       │
       ▼
 [ Tick every 60s ] ──> Read active 'automations' from SQLite DB
       │
       ▼
 [ Match Cron? ] ─────> Match Cron Expressions (* * * * * or hourly)
       │
       ├─► No  ──► Sleep
       │
       └─► Yes ──► Spawn [ runHeadlessAutomation ]
                       │
                       ▼
                 [ ReAct Loop ] (Runs in headless sandbox)
                       │
                       ▼
                 [ Output logs ] ──> Saved to SQLite `automation_runs`
```

---

## 💾 SQLite Database Tables

### `automations`
Stores defined automation prompt tasks and Cron configurations.
- `id` (TEXT PRIMARY KEY)
- `name` (TEXT)
- `cron` (TEXT - e.g. `*/5 * * * *`)
- `prompt` (TEXT - autonomous instructions)
- `enabled` (INTEGER - 0 or 1)
- `last_run` (TEXT)
- `created_at` (TEXT)

### `automation_runs`
Maintains records of all triggered events.
- `id` (TEXT PRIMARY KEY)
- `automation_id` (TEXT)
- `status` (TEXT: running, success, failed, awaitingApproval)
- `output` (TEXT)
- `created_at` (TEXT)
