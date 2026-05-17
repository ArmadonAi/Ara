# Ara Personal AI Control Plane - Backend API Specifications

This document outlines the API contracts and endpoint payloads for the Ara Personal AI Control Plane Hono gateway server running on port `3001`.

---

## 🖥️ System Status

### `GET /api/status`
Retrieves execution status metrics of the DB, sandbox engine, custom progressive skills, pending security authorization requests, and active default routing profile.
* **Response `200 OK`**:
```json
{
  "status": "ok",
  "version": "0.1.0",
  "database": "ok",
  "pendingApprovalsCount": 0,
  "skillsCount": 3,
  "sandboxMode": false,
  "memoryEnabled": true,
  "activeModel": "Gemini"
}
```

---

## 💬 Conversation Sessions

### `GET /api/sessions`
List all active and historical chat sessions stored inside SQLite ordered by updated timestamp.
* **Response `200 OK`**:
```json
[
  {
    "id": "test-session",
    "title": "การสนทนาใหม่",
    "model": "Gemini",
    "messageCount": 2,
    "createdAt": "2026-05-17T08:00:00.000Z",
    "updatedAt": "2026-05-17T08:05:00.000Z"
  }
]
```

### `POST /api/sessions`
Spawn a clean interactive conversation session with standard parameters.
* **Payload**:
```json
{
  "model": "Gemini",
  "title": "Project Refactoring"
}
```
* **Response `201 Created`**:
```json
{
  "id": "sess-82a17b",
  "title": "Project Refactoring",
  "model": "Gemini",
  "messages": [],
  "createdAt": "2026-05-17T08:10:00.000Z",
  "updatedAt": "2026-05-17T08:10:00.000Z"
}
```

### `GET /api/sessions/:id`
Fetch message history sequence and active configurations for a specific session ID.
* **Response `200 OK`**:
```json
{
  "id": "sess-82a17b",
  "title": "Project Refactoring",
  "model": "Gemini",
  "messages": [
    {
      "id": "msg-u1",
      "role": "user",
      "content": "Verify file structure.",
      "createdAt": "2026-05-17T08:10:05.000Z"
    }
  ],
  "createdAt": "2026-05-17T08:10:00.000Z",
  "updatedAt": "2026-05-17T08:10:05.000Z"
}
```

---

## 🚀 Chat & Tool Executions

### `POST /api/sessions/:id/messages`
Send message to runtime loop and return Server-Sent Events (SSE) text stream.
* **Payload**:
```json
{
  "content": "List all TypeScript files in this project."
}
```
* **SSE Stream Yields**:
  - Raw assistant markdown replies
  - XML `<tool_call>` blocks
  - XML `<tool_call>` execution states
  - Security authentication bulletins: `awaitingApproval`

---

## 🛡️ Tool Approvals & Security Gate

### `GET /api/approvals`
Fetch full historical tool run permissions and pending request logs.
* **Response `200 OK`**:
```json
[
  {
    "id": "appr-3v2s",
    "sessionId": "sess-82a17b",
    "toolName": "run_shell",
    "input": "{\"command\":\"npm run test\"}",
    "riskLevel": "dangerous",
    "reason": "Shell execution could write files.",
    "status": "pending",
    "createdAt": "2026-05-17T08:11:00.000Z"
  }
]
```

### `POST /api/approvals/:id/resolve`
Approve or reject a pending secure execution checkpoint.
* **Payload**:
```json
{
  "action": "approve" // or "reject"
}
```
* **Response `200 OK`**:
```json
{
  "success": true,
  "status": "approved",
  "output": "All 35 tests passed successfully."
}
```

---

## 🗜️ Pruning & History Branching

### `POST /api/sessions/:id/compact`
Prune intermediate conversational exchanges into a single rich historical compaction digest to maximize context window capacity.
* **Response `200 OK`**:
```json
{
  "success": true,
  "compactedCount": 12,
  "message": "Compaction completed successfully"
}
```

### `POST /api/sessions/:id/fork`
Fork historical messages of an existing session into a clean branching session.
* **Payload**:
```json
{
  "messageIndex": 4
}
```
* **Response `201 Created`**: Returns new branched chat session state.

### `POST /api/sessions/:id/resume`
Resettle execution state and append `session.resumed` transcript event records.
* **Response `200 OK`**: Returns current session state.

---

## 🤖 Model Scoping Configuration

### `POST /api/config`
Updates Hono gateway default model routing parameters (Global config scope).
* **Payload**:
```json
{
  "defaultModel": "OpenAI"
}
```

### `PATCH /api/sessions/:id/config`
Updates model configuration settings for a singular chat session only (Session config scope).
* **Payload**:
```json
{
  "activeModel": "Ollama:llama3"
}
```

---

## 🔒 Workspace Checkpoints & Rewind

Checkpoints capture the full state of the workspace (files + session transcript) at a point in time, enabling safe code and conversation rewind.

### `GET /api/checkpoints`
List all checkpoints across the workspace.
* **Response `200 OK`**:
```json
[
  {
    "id": "chk_a1b2c3d4",
    "sessionId": "sess-82a17b",
    "reason": "Refactor start",
    "createdAt": "2026-05-17T08:10:00.000Z",
    "createdBy": "user",
    "messageCount": 4,
    "filesCount": 12
  }
]
```

### `GET /api/sessions/:id/checkpoints`
List checkpoints filtered to a specific session.
* **Response `200 OK`**: Same structure as `GET /api/checkpoints`.

### `POST /api/sessions/:id/checkpoints`
Create a manual (or automated) checkpoint. Before mutating tools (`write_file`, `edit_file`, `run_shell`), Ara creates an automatic safety checkpoint here.
* **Payload**:
```json
{
  "reason": "Refactor start",
  "createdBy": "user",
  "specificFiles": ["src/app.ts", "src/utils.ts"],
  "metadata": { "tag": "before-refactor" }
}
```
* **Response `201 Created`**:
```json
{
  "id": "chk_a1b2c3d4",
  "sessionId": "sess-82a17b",
  "reason": "Refactor start",
  "createdAt": "2026-05-17T08:10:00.000Z",
  "messageCount": 4,
  "filesCount": 12,
  "gitHead": "abc123..."
}
```

### `GET /api/checkpoints/:id`
Retrieve full details of a specific checkpoint including its file snapshot index.
* **Response `200 OK`**: Full `Checkpoint` object.
* **Response `404 Not Found`**: `Checkpoint not found`.

### `GET /api/checkpoints/:id/diff`
Return a structured diff of the current workspace relative to the checkpoint state.
* **Response `200 OK`**:
```json
{
  "filesChangedSince": ["src/app.ts"],
  "filesCreatedSince": ["src/newFeature.ts"],
  "filesDeletedSince": ["src/oldFeature.ts"],
  "filesSkipped": ["node_modules/pkg/index.js"],
  "messageCountDiff": 5,
  "transcriptSeqDiff": 8
}
```

### `POST /api/checkpoints/:id/restore`
Restore workspace files and/or session messages to checkpoint state. **A pre-restore safety checkpoint** is automatically created before the restore runs, so you can always undo a rewind.
* **Payload**:
```json
{
  "mode": "code_only"
}
```
* **Restore modes**:
  | Mode | Files | Messages |
  |------|-------|----------|
  | `code_only` | Restored | Left as-is |
  | `conversation_only` | Left as-is | Rewound to snapshot |
  | `both` | Restored | Rewound to snapshot |
* **Response `200 OK`**:
```json
{
  "success": true,
  "restoredFiles": ["src/app.ts", "src/utils.ts"],
  "messageCount": 4,
  "message": "Restored chk_a1b2c3d4 with mode code_only"
}
```

---

## 📜 Incremental Event-Based Transcripts

### `GET /api/sessions/:id/transcript`
Retrieve incremental JSONL lifecycle events trace.
* **Response `200 OK`**:
```json
[
  {
    "seq": 1,
    "timestamp": "2026-05-17T08:10:00.000Z",
    "sessionId": "sess-82a17b",
    "eventType": "session.created",
    "payload": {
      "model": "Gemini",
      "title": "Project Refactoring"
    }
  },
  {
    "seq": 2,
    "timestamp": "2026-05-17T08:10:05.000Z",
    "sessionId": "sess-82a17b",
    "eventType": "message.appended",
    "payload": {
      "message": {
        "id": "msg-u1",
        "role": "user",
        "content": "Verify file structure."
      }
    }
  }
]
```

### `POST /api/sessions/:id/transcript/rebuild`
Reconstruct SQLite messages list by replaying the incremental transcript event history log file.
* **Response `200 OK`**:
```json
{
  "success": true,
  "message": "Database messages successfully rebuilt from transcript event history"
}
```
