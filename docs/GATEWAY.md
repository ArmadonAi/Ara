# Ara Gateway

Real-time messaging gateway that connects AI agents to external messaging platforms via WebSocket and REST.

## Architecture

```
Messaging Platforms                    Gateway                        Clients
┌──────────────┐              ┌───────────────────┐          ┌──────────────┐
│  Telegram     │──polling──→│  Channel Interface │──WS────→│  Web UI      │
│  (Bot API)    │              │                   │          ├──────────────┤
├──────────────┤              │  TelegramChannel   │──WS────→│  CLI         │
│  LINE         │──webhook──→│  LineChannel       │          ├──────────────┤
│  (Messaging   │              │                   │          │  Custom      │
│   API)        │              │  (future channels) │         │  Clients     │
└──────────────┘              └───────────────────┘          └──────────────┘
                                      │
                                      ▼
                              ┌──────────────┐
                              │  AgentRuntime │
                              │  (ReAct loop) │
                              └──────────────┘
```

The Gateway:
1. Receives messages from platforms (Telegram long-polling, LINE webhook)
2. Routes them through the Agent Runtime for AI processing
3. Sends responses back to the platform
4. Broadcasts real-time events via WebSocket to all connected clients

## Channel Interface

Every messaging platform implements the `Channel` interface (`apps/api/src/channel.ts`):

```typescript
interface Channel {
  readonly name: string;
  start(): Promise<void>;
  stop(): void;
  status(): ChannelStatus;
}

interface ChannelStatus {
  name: string;
  running: boolean;
  healthy: boolean;
  info: Record<string, any>;
}
```

## WebSocket Protocol

Clients connect via `ws://localhost:3001/ws` (or configured API port).

### Message Format

**Request:**
```json
{
  "type": "req",
  "id": "unique-id",
  "method": "method.name",
  "params": { ... }
}
```

**Response:**
```json
{
  "type": "res",
  "id": "unique-id",
  "ok": true,
  "payload": { ... }
}
```

**Server Event (broadcast):**
```json
{
  "type": "event",
  "event": "gateway.status",
  "payload": { ... },
  "timestamp": "2025-01-01T00:00:00.000Z"
}
```

### Registered Methods

| Method | Params | Description |
|--------|--------|-------------|
| `gateway.status` | none | List all channels with running/healthy state |
| `gateway.restartChannel` | `{ name }` | Restart a channel by name |
| `sessions.list` | none | List recent AI sessions |
| `approvals.list` | none | List pending tool approvals |

### Events

| Event | Payload | When |
|-------|---------|------|
| `gateway.status` | `{ channels, clientId }` | On WS connect |

## Telegram Channel

Implementation: `apps/api/src/telegram.ts`

### Features
- Long-polling (no webhook needed — works behind NAT/firewall)
- Text, image, document, voice, video, sticker support
- Group chats with mention gating
- Inline keyboard for tool approval
- Streaming replies (edits message as response streams)
- 4096-char message splitting
- HTML formatting

### Configuration

Create `.ara/telegram.json` (auto-created on first start):

```json
{
  "botToken": "123456:ABC-DEF...",
  "enabled": true,
  "allowFrom": [],
  "groupPolicy": "disabled",
  "groups": {},
  "streaming": true
}
```

Or set `TELEGRAM_BOT_TOKEN` env var (overrides file).

| Field | Default | Description |
|-------|---------|-------------|
| `botToken` | `""` | Telegram Bot API token |
| `enabled` | `true` | Enable/disable the bot |
| `allowFrom` | `[]` | Allowed user IDs (empty = all allowed) |
| `groupPolicy` | `"disabled"` | `"disabled"`, `"allowlist"`, or `"open"` |
| `groups` | `{}` | Per-group config with `allowFrom` and `requireMention` |
| `streaming` | `true` | Stream responses as they're generated |

### Group Access Control

```json
{
  "groupPolicy": "allowlist",
  "groups": {
    "-1001234567890": {
      "allowFrom": [12345, 67890],
      "requireMention": true
    }
  }
}
```

- `requireMention: true` — bot only responds when `@botname` is in the message
- `allowFrom` — restrict which group members can interact

## LINE Channel

Implementation: `apps/api/src/line.ts`

### Features
- Webhook-based (LINE calls your API)
- Signature verification (HMAC-SHA256)
- Text, image, video, audio, location, sticker support
- Group chats with access control
- Loading animation while processing
- 5000-char message chunking

### Configuration

Create `.ara/line.json` (auto-created on first start):

```json
{
  "channelAccessToken": "...",
  "channelSecret": "...",
  "enabled": true,
  "allowFrom": [],
  "groupPolicy": "disabled",
  "groups": {},
  "mediaMaxMb": 10
}
```

Or set `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_CHANNEL_SECRET` env vars.

### Webhook Setup

LINE requires a public HTTPS endpoint. Configure your LINE Developer Console to point to:

```
https://your-domain.com/api/webhooks/line
```

For local development, use a tunnel (ngrok, Cloudflare Tunnel, etc.).

## REST API Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/gateway/status` | All channel statuses |
| `POST` | `/api/gateway/channels/:name/restart` | Restart a channel |
| `POST` | `/api/gateway/channels/:name/stop` | Stop a channel |
| `POST` | `/api/webhooks/telegram` | Telegram webhook (unused — uses polling) |
| `POST` | `/api/webhooks/line` | LINE webhook endpoint |

## Channel Automation Triggers

Automations can be triggered by keyword matches in incoming messages.

When creating/updating an automation, set:
- `channelTrigger`: `"telegram"` or `"line"`
- `keyword`: Text to match (case-insensitive, partial match)
- If matched, the automation runs headlessly and the message is NOT sent to the agent

Example automation for Telegram:
```json
{
  "name": "Daily Report",
  "prompt": "Generate a summary of recent git activity",
  "cron": "0 9 * * *",
  "channelTrigger": "telegram",
  "keyword": "/report"
}
```

Sending `/report` in a Telegram chat triggers the automation instead of starting a conversation.

## Adding a New Channel

1. Create `apps/api/src/<name>.ts`
2. Implement the `Channel` interface
3. Add message handling with `AgentRuntime.streamAgentLoop()`
4. Register in `apps/api/src/index.ts`:
   ```typescript
   gateway.register(new MyChannel(runtime, db));
   ```
5. Add config template creation in `loadConfig()`
6. Add REST webhook route if needed
7. Write tests in `tests/gateway.test.ts`

## CLI Commands

```bash
ara gateway status              # Show channel statuses
ara gateway restart <name>      # Restart a channel
ara gateway stop <name>         # Stop a channel
```

## Web UI

Gateway channel status is displayed in the sidebar of the Ara Web UI:

- Green dot: channel running
- Red dot: channel stopped
- Channel name and state shown inline

## Testing

```bash
bun test tests/gateway.test.ts
```

Tests cover: protocol methods, gateway lifecycle, channel registration, config auto-creation, and broadcast events.
