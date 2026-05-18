// ── Telegram Bot Module ──────────────────────────────────────────
// Full-featured Telegram integration with long polling, media support,
// group chats, streaming replies, inline keyboards, and HTML formatting.
// No external dependencies — uses fetch against Telegram Bot API.

import type { ChatSession, Message } from '@ara/shared';
import type { Channel, ChannelStatus, AutomationTrigger } from './channel';
import type { AgentRuntime } from '@ara/agent-core';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── Types ──────────────────────────────────────────────────────

interface TelegramConfig {
  botToken: string;
  enabled: boolean;
  allowFrom: number[];
  groupPolicy: 'disabled' | 'allowlist' | 'open';
  groups: Record<string, { allowFrom?: number[]; requireMention?: boolean }>;
  streaming: boolean;
}

interface TgUser { id: number; first_name?: string; username?: string }
interface TgChat { id: number; type: 'private' | 'group' | 'supergroup' | 'channel'; title?: string }
interface TgMessage {
  message_id: number;
  text?: string;
  chat: TgChat;
  from?: TgUser;
  photo?: { file_id: string }[];
  document?: { file_id: string; file_name?: string };
  voice?: { file_id: string };
  video?: { file_id: string };
  sticker?: { file_id: string; emoji?: string };
  caption?: string;
  reply_to_message?: { text?: string; message_id: number };
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: {
    id: string;
    data?: string;
    message?: { message_id: number; chat: TgChat };
    from: TgUser;
  };
}

// ─── Defaults ──────────────────────────────────────────────────

const UPLOADS_DIR = path.join(process.cwd(), '.ara', 'uploads');
const TG_API = 'https://api.telegram.org/bot';

// ─── Config ─────────────────────────────────────────────────────

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function ensureTelegramConfig(): void {
  const cfgPath = path.join(process.cwd(), '.ara', 'telegram.json');
  if (!fs.existsSync(cfgPath)) {
    ensureDir(path.dirname(cfgPath));
    fs.writeFileSync(cfgPath, JSON.stringify({
      botToken: '',
      enabled: true,
      allowFrom: [],
      groupPolicy: 'disabled',
      groups: {},
      streaming: true,
      _note: 'Set botToken or use TELEGRAM_BOT_TOKEN env var',
    }, null, 2));
    console.log('Telegram: created default config at .ara/telegram.json');
  }
}

export function loadConfig(): TelegramConfig {
  ensureTelegramConfig();
  const cfgPath = path.join(process.cwd(), '.ara', 'telegram.json');
  let cfg: Partial<TelegramConfig> = {};
  if (fs.existsSync(cfgPath)) {
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')); } catch {}
  }
  return {
    botToken: cfg.botToken || process.env.TELEGRAM_BOT_TOKEN || '',
    enabled: cfg.enabled !== false,
    allowFrom: cfg.allowFrom || [],
    groupPolicy: cfg.groupPolicy || 'disabled',
    groups: cfg.groups || {},
    streaming: cfg.streaming !== false,
  };
}

// ─── API helpers ────────────────────────────────────────────────

async function tgApi(token: string, method: string, body?: any): Promise<any> {
  try {
    const res = await fetch(`${TG_API}${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    return data;
  } catch { return { ok: false }; }
}

async function tgSend(token: string, chatId: number | string, text: string, opts: any = {}): Promise<any> {
  // Split messages over 4096 chars
  const MAX = 4096;
  if (text.length > MAX) {
    let first = true;
    for (let i = 0; i < text.length; i += MAX) {
      const chunk = text.slice(i, i + MAX);
      if (first) {
        await tgApi(token, 'sendMessage', { chat_id: chatId, text: chunk, ...opts });
        first = false;
      } else {
        await tgApi(token, 'sendMessage', { chat_id: chatId, text: chunk });
      }
    }
    return;
  }
  return tgApi(token, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...opts });
}

async function tgEdit(token: string, chatId: number | string, msgId: number, text: string, opts: any = {}) {
  return tgApi(token, 'editMessageText', { chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML', ...opts });
}

async function tgAction(token: string, chatId: number | string, action: string) {
  return tgApi(token, 'sendChatAction', { chat_id: chatId, action });
}

async function tgAnswerCb(token: string, cbId: string, text?: string) {
  return tgApi(token, 'answerCallbackQuery', { callback_query_id: cbId, text, show_alert: false });
}

async function downloadFile(token: string, fileId: string): Promise<string | null> {
  try {
    ensureDir(UPLOADS_DIR);
    const info = await tgApi(token, 'getFile', { file_id: fileId });
    if (!info.ok || !info.result?.file_path) return null;
    const fp = info.result.file_path as string;
    const dl = await fetch(`${TG_API}${token}/${fp}`);
    if (!dl.ok) return null;
    const buf = await dl.arrayBuffer();
    const name = `tg_${Date.now()}_${path.basename(fp)}`;
    const local = path.join(UPLOADS_DIR, name);
    fs.writeFileSync(local, Buffer.from(buf));
    return local;
  } catch { return null; }
}

// ─── Access control ─────────────────────────────────────────────

function isAllowedUser(userId: number, cfg: TelegramConfig): boolean {
  if (cfg.allowFrom.length === 0) return true; // no restrictions
  return cfg.allowFrom.includes(userId);
}

function isAllowedGroup(chatId: number, cfg: TelegramConfig): boolean {
  if (cfg.groupPolicy === 'disabled') return false;
  if (cfg.groupPolicy === 'open') return true;
  // allowlist
  return !!cfg.groups[String(chatId)];
}

function requiresMention(chatId: number, cfg: TelegramConfig): boolean {
  return cfg.groups[String(chatId)]?.requireMention ?? true;
}

// ─── Build inline keyboard for approvals ────────────────────────

function approvalKeyboard(approvalId: string) {
  return {
    inline_keyboard: [[
      { text: 'Approve', callback_data: `approve:${approvalId}` },
      { text: 'Reject', callback_data: `reject:${approvalId}` },
    ]]
  };
}

// ─── HTML escape ────────────────────────────────────────────────

function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Message handler ────────────────────────────────────────────

async function handleMessage(
  msg: TgMessage,
  cfg: TelegramConfig,
  runtime: AgentRuntime,
  db: Database,
  onAutomation?: AutomationTrigger,
) {
  const chatId = msg.chat.id;
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
  const userId = msg.from?.id || 0;
  const sessionId = isGroup ? `tg-group-${chatId}` : `tg-${chatId}`;

  // Access control
  if (isGroup && !isAllowedGroup(chatId, cfg)) return;
  if (!isGroup && !isAllowedUser(userId, cfg)) {
    await tgSend(cfg.botToken, chatId, 'Sorry, you are not authorized.');
    return;
  }
  // Group mention check
  if (isGroup && requiresMention(chatId, cfg)) {
    const text = msg.text || msg.caption || '';
    const botName = (await tgApi(cfg.botToken, 'getMe'))?.result?.username || '';
    if (!text.includes('@' + botName)) return;
  }

  // Check for channel automation trigger (keyword match)
  const textContent = msg.text || msg.caption || '';
  if (onAutomation && textContent) {
    const triggered = onAutomation('telegram', String(userId), textContent);
    if (triggered) {
      await tgSend(cfg.botToken, chatId, 'Running automation...');
      return; // Don't process as a normal chat message
    }
  }

  // Build content from message
  const contentParts: string[] = [];

  // Photo
  if (msg.photo) {
    const largest = msg.photo[msg.photo.length - 1];
    const p = await downloadFile(cfg.botToken, largest.file_id);
    contentParts.push(p ? `[Image: ${path.basename(p)}]` : '[Image: dl failed]');
  }
  // Document
  if (msg.document) {
    const p = await downloadFile(cfg.botToken, msg.document.file_id);
    contentParts.push(p ? `[File: ${msg.document.file_name || path.basename(p)}]` : `[File: ${msg.document.file_name || 'unknown'} dl failed]`);
  }
  // Voice
  if (msg.voice) {
    const p = await downloadFile(cfg.botToken, msg.voice.file_id);
    contentParts.push(p ? `[Voice: ${path.basename(p)}]` : '[Voice: dl failed]');
  }
  // Video
  if (msg.video) {
    const p = await downloadFile(cfg.botToken, msg.video.file_id);
    contentParts.push(p ? `[Video: ${path.basename(p)}]` : '[Video: dl failed]');
  }
  // Sticker
  if (msg.sticker) {
    contentParts.push(`[Sticker: ${msg.sticker.emoji || 'sticker'}]`);
  }
  // Text
  const text = msg.text || msg.caption || '';
  if (text) contentParts.push(text);

  const userContent = contentParts.join('\n');
  if (!userContent) return;

  // Get/create session
  let session = getSession(db, sessionId);
  if (!session) {
    const title = isGroup ? `TG Group ${chatId}` : `TG Chat ${userId}`;
    db.run(
      'INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [sessionId, title, 'Gemini', new Date().toISOString(), new Date().toISOString()]
    );
    session = getSession(db, sessionId)!;
  }

  // Save user message
  const userMsg: Message = {
    id: Math.random().toString(36).substring(7),
    role: 'user',
    content: userContent,
    createdAt: new Date(),
  };
  saveMessage(db, sessionId, userMsg);
  session.messages.push(userMsg);

  // Send typing
  tgAction(cfg.botToken, chatId, 'typing');

  // Execute agent loop
  let fullContent = '';
  let previewMsgId: number | null = null;
  let lastPreview = '';

  for await (const chunk of runtime.streamAgentLoop(session, userContent, {
    onAuditLog: (log) => {
      const auditId = Math.random().toString(36).substring(7);
      db.run(
        'INSERT INTO audit_logs (id, session_id, tool_name, input, output, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [auditId, sessionId, log.toolName, JSON.stringify(log.input), log.outputSummary, log.status, new Date().toISOString()]
      );
    }
  })) {
    if (chunk.awaitingApproval) {
      // Create approval in DB
      const approvalId = Math.random().toString(36).substring(7);
      db.run(
        'INSERT INTO approvals (id, session_id, tool_name, input, risk_level, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [approvalId, sessionId, chunk.awaitingApproval.toolName, JSON.stringify(chunk.awaitingApproval.input), chunk.awaitingApproval.dangerLevel, chunk.awaitingApproval.reason, 'pending', new Date().toISOString()]
      );
      // Send approval request with inline keyboard
      const approvalText = `⚠️ Need approval for: <b>${htmlEscape(chunk.awaitingApproval.toolName)}</b>\n${htmlEscape(chunk.awaitingApproval.reason || '')}`;
      if (cfg.streaming && previewMsgId) {
        await tgEdit(cfg.botToken, chatId, previewMsgId, approvalText, { reply_markup: approvalKeyboard(approvalId) });
      } else {
        const sent = await tgSend(cfg.botToken, chatId, approvalText, { reply_markup: approvalKeyboard(approvalId) });
        if (sent?.ok) previewMsgId = sent.result?.message_id || null;
      }
    }
    if (chunk.text) {
      fullContent += chunk.text;
      // Streaming: update preview message
      if (cfg.streaming && chunk.text.length > 0 && fullContent.length < 4000) {
        const preview = fullContent.slice(-2000);
        if (preview !== lastPreview && previewMsgId) {
          await tgEdit(cfg.botToken, chatId, previewMsgId, preview);
          lastPreview = preview;
        } else if (!previewMsgId) {
          const sent = await tgSend(cfg.botToken, chatId, '...');
          if (sent?.ok) previewMsgId = sent.result?.message_id || null;
        }
      }
    }
  }

  // Save assistant message
  const assistantMsg: Message = {
    id: Math.random().toString(36).substring(7),
    role: 'assistant',
    content: fullContent,
    createdAt: new Date(),
  };
  saveMessage(db, sessionId, assistantMsg);

  // Send final reply
  if (!fullContent) {
    fullContent = "Sorry, I couldn't compute a reply.";
  }
  const escaped = htmlEscape(fullContent);
  if (previewMsgId && cfg.streaming) {
    await tgEdit(cfg.botToken, chatId, previewMsgId, escaped);
  } else {
    await tgSend(cfg.botToken, chatId, escaped);
  }
}

// ─── Session helpers (mirror from index.ts) ─────────────────────

function getSession(db: Database, id: string): ChatSession | null {
  const row = db.query('SELECT * FROM sessions WHERE id = ?').get(id) as any;
  if (!row) return null;
  const msgs = db.query('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC').all(id) as any[];
  return {
    id: row.id,
    title: row.title,
    model: row.model,
    messageCount: msgs.length,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    messages: msgs.map(m => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: new Date(m.created_at),
    })),
  } as ChatSession;
}

function saveMessage(db: Database, sessionId: string, msg: Message) {
  db.run(
    'INSERT OR REPLACE INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
    [msg.id, sessionId, msg.role, msg.content, msg.createdAt.toISOString()]
  );
}

// ─── Callback query handler (for inline keyboards) ──────────────

async function handleCallbackQuery(
  cb: NonNullable<TgUpdate['callback_query']>,
  cfg: TelegramConfig,
  db: Database,
) {
  const data = cb.data || '';
  const chatId = cb.message?.chat.id;
  const msgId = cb.message?.message_id;
  if (!chatId || !msgId) return;

  const [action, approvalId] = data.split(':');
  if (!action || !approvalId) return;

  if (action === 'approve' || action === 'reject') {
    const status = action === 'approve' ? 'approved' : 'rejected';
    db.run('UPDATE approvals SET status = ? WHERE id = ?', [status, approvalId]);
    // Resolve via API
    try {
      const baseUrl = `http://127.0.0.1:${process.env.API_PORT || 3001}`;
      await fetch(`${baseUrl}/api/approvals/${approvalId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: action === 'approve' ? 'approve' : 'reject' }),
      });
    } catch {}
    await tgEdit(cfg.botToken, chatId, msgId,
      action === 'approve' ? 'Approved.' : 'Rejected.',
      { reply_markup: { inline_keyboard: [] } }
    );
    await tgAnswerCb(cfg.botToken, cb.id, action === 'approve' ? 'Approved' : 'Rejected');
  }
}

// ─── Polling loop ───────────────────────────────────────────────

let polling = false;
let pollPromise: Promise<void> | null = null;

export async function startTelegramBot(runtime: AgentRuntime, db: Database, onAutomation?: AutomationTrigger) {
  const cfg = loadConfig();
  if (!cfg.enabled || !cfg.botToken) {
    console.log('Telegram: disabled (no token)');
    return;
  }

  // Verify token
  const me = await tgApi(cfg.botToken, 'getMe');
  if (!me.ok) {
    console.log('Telegram: invalid token, bot not started');
    return;
  }
  console.log(`Telegram: started as @${me.result?.username || 'unknown'}`);

  polling = true;
  let offset = 0;

  pollPromise = (async () => {
    while (polling) {
      try {
        const res = await fetch(
          `${TG_API}${cfg.botToken}/getUpdates?offset=${offset}&timeout=30&allowed_updates=["message","callback_query"]`
        );
        if (!res.ok) { await sleep(5000); continue; }
        const data = await res.json() as { ok: boolean; result?: TgUpdate[] };
        if (!data.ok || !data.result) continue;

        for (const update of data.result) {
          offset = update.update_id + 1;

          if (update.message) {
            handleMessage(update.message, cfg, runtime, db, onAutomation).catch(e =>
              console.error('Telegram msg error:', e)
            );
          }
          if (update.callback_query) {
            handleCallbackQuery(update.callback_query, cfg, db).catch(e =>
              console.error('Telegram cb error:', e)
            );
          }
        }
      } catch (e: any) {
        console.error('Telegram poll error:', e.message);
        await sleep(3000);
      }
    }
  })();
}

export function stopTelegramBot() {
  polling = false;
}

export function getTelegramStatus(): { running: boolean; config: { enabled: boolean; hasToken: boolean; groupPolicy: string } } {
  const cfg = loadConfig();
  return {
    running: polling,
    config: {
      enabled: cfg.enabled,
      hasToken: !!cfg.botToken,
      groupPolicy: cfg.groupPolicy,
    },
  };
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ─── Channel adapter ────────────────────────────────────────

export class TelegramChannel implements Channel {
  readonly name = "telegram";
  private _runtime: AgentRuntime;
  private _db: Database;
  private _onAutomation?: AutomationTrigger;

  constructor(runtime: AgentRuntime, db: Database, onAutomation?: AutomationTrigger) {
    this._runtime = runtime;
    this._db = db;
    this._onAutomation = onAutomation;
  }

  async start(): Promise<void> {
    await startTelegramBot(this._runtime, this._db, this._onAutomation);
  }

  stop(): void {
    stopTelegramBot();
  }

  status(): ChannelStatus {
    const s = getTelegramStatus();
    return { name: "telegram", running: s.running, healthy: s.running, info: s.config };
  }
}
