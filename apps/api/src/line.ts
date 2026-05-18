// ── LINE Bot Module ─────────────────────────────────────────────
// Full-featured LINE Messaging API integration with signature verification,
// media support, group chats, loading animation, and rich messages.
// No external dependencies — uses fetch and Web Crypto API.

import type { ChatSession, Message } from '@ara/shared';
import type { AgentRuntime } from '@ara/agent-core';
import type { Channel, ChannelStatus, AutomationTrigger } from './channel';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import crypto from 'node:crypto';

// ─── Types ──────────────────────────────────────────────────────

interface LineConfig {
  channelAccessToken: string;
  channelSecret: string;
  enabled: boolean;
  allowFrom: string[];
  groupPolicy: 'disabled' | 'allowlist' | 'open';
  groups: Record<string, { allowFrom?: string[] }>;
  mediaMaxMb: number;
}

interface LineEvent {
  type: string;
  replyToken?: string;
  source?: { userId?: string; groupId?: string; roomId?: string; type: string };
  message?: {
    id: string;
    type: string;
    text?: string;
    title?: string;
    address?: string;
    latitude?: number;
    longitude?: number;
    packageId?: string;
    stickerId?: string;
  };
}

// ─── Defaults ──────────────────────────────────────────────────

const UPLOADS_DIR = path.join(process.cwd(), '.ara', 'uploads');
const LINE_API = 'https://api.line.me/v2/bot/message';

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ─── Config ─────────────────────────────────────────────────────

function ensureLineConfig(): void {
  const cfgPath = path.join(process.cwd(), '.ara', 'line.json');
  if (!fs.existsSync(cfgPath)) {
    ensureDir(path.dirname(cfgPath));
    fs.writeFileSync(cfgPath, JSON.stringify({
      channelAccessToken: '',
      channelSecret: '',
      enabled: true,
      allowFrom: [],
      groupPolicy: 'disabled',
      groups: {},
      mediaMaxMb: 10,
      _note: 'Set channelAccessToken/channelSecret or use LINE_CHANNEL_ACCESS_TOKEN/LINE_CHANNEL_SECRET env vars',
    }, null, 2));
    console.log('LINE: created default config at .ara/line.json');
  }
}

export function loadConfig(): LineConfig {
  ensureLineConfig();
  const cfgPath = path.join(process.cwd(), '.ara', 'line.json');
  let cfg: Partial<LineConfig> = {};
  if (fs.existsSync(cfgPath)) {
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')); } catch {}
  }
  return {
    channelAccessToken: cfg.channelAccessToken || process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
    channelSecret: cfg.channelSecret || process.env.LINE_CHANNEL_SECRET || '',
    enabled: cfg.enabled !== false,
    allowFrom: cfg.allowFrom || [],
    groupPolicy: cfg.groupPolicy || 'disabled',
    groups: cfg.groups || {},
    mediaMaxMb: cfg.mediaMaxMb || 10,
  };
}

// ─── Signature Verification ─────────────────────────────────────

function verifySignature(body: string, signature: string, secret: string): boolean {
  try {
    const hmac = crypto.createHmac('SHA256', secret);
    hmac.update(body, 'utf-8');
    const expected = hmac.digest('base64');
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch { return false; }
}

// ─── API helpers ────────────────────────────────────────────────

async function lineApi(token: string, method: string, body?: any): Promise<any> {
  try {
    const url = method.startsWith('/') ? `https://api.line.me${method}` : `${LINE_API}/${method}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { ok: res.ok, status: res.status };
  } catch { return { ok: false }; }
}

async function lineReply(token: string, replyToken: string, messages: any[]) {
  return lineApi(token, 'reply', { replyToken, messages });
}

async function linePush(token: string, to: string, messages: any[]) {
  return lineApi(token, 'push', { to, messages });
}

async function lineLoading(token: string, chatId: string) {
  return fetch('https://api.line.me/v2/bot/chat/loading/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ chatId }),
  });
}

async function downloadContent(token: string, messageId: string, ext: string): Promise<string | null> {
  try {
    ensureDir(UPLOADS_DIR);
    const dl = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!dl.ok) return null;
    const buf = await dl.arrayBuffer();
    const name = `line_${Date.now()}.${ext}`;
    const local = path.join(UPLOADS_DIR, name);
    fs.writeFileSync(local, Buffer.from(buf));
    return local;
  } catch { return null; }
}

// ─── Access control ─────────────────────────────────────────────

function isAllowedUser(userId: string, cfg: LineConfig): boolean {
  if (cfg.allowFrom.length === 0) return true;
  return cfg.allowFrom.includes(userId) || cfg.allowFrom.includes('*');
}

function isAllowedGroup(groupId: string, cfg: LineConfig): boolean {
  if (cfg.groupPolicy === 'disabled') return false;
  if (cfg.groupPolicy === 'open') return true;
  return !!cfg.groups[groupId];
}

// ─── HTML escape for LINE ───────────────────────────────────────

function plainText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Session helpers ────────────────────────────────────────────

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

function saveMsg(db: Database, sessionId: string, msg: Message) {
  db.run(
    'INSERT OR REPLACE INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
    [msg.id, sessionId, msg.role, msg.content, msg.createdAt.toISOString()]
  );
}

// ─── Event handler ──────────────────────────────────────────────

async function handleEvent(
  event: LineEvent,
  cfg: LineConfig,
  runtime: AgentRuntime,
  db: Database,
  onAutomation?: AutomationTrigger,
) {
  if (event.type !== 'message' || !event.message || !event.source) return;

  // Check for channel automation trigger (keyword match)
  if (onAutomation && event.message.text) {
    const userId = event.source.userId || 'unknown';
    const triggered = onAutomation('line', userId, event.message.text);
    if (triggered) return; // Don't process as normal chat
  }

  const source = event.source;
  const isGroup = source.type === 'group' || source.type === 'room';
  const chatId = isGroup ? (source.groupId || source.roomId || '') : (source.userId || '');
  const userId = source.userId || '';
  const sanitizedId = userId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 30);
  const sessionId = isGroup ? `line-group-${chatId.slice(0, 20)}` : `line-${sanitizedId}`;

  // Access control
  if (isGroup && !isAllowedGroup(chatId, cfg)) return;
  if (!isGroup && !isAllowedUser(userId, cfg)) return;

  const replyToken = event.replyToken || '';

  // Build content
  let userContent = '';
  switch (event.message.type) {
    case 'text':
      userContent = (event.message.text || '').trim();
      break;
    case 'image': {
      const p = await downloadContent(cfg.channelAccessToken, event.message.id, 'jpg');
      userContent = p ? `[Image: ${path.basename(p)}]` : '[Image: dl failed]';
      break;
    }
    case 'video': {
      const p = await downloadContent(cfg.channelAccessToken, event.message.id, 'mp4');
      userContent = p ? `[Video: ${path.basename(p)}]` : '[Video: dl failed]';
      break;
    }
    case 'audio': {
      const p = await downloadContent(cfg.channelAccessToken, event.message.id, 'm4a');
      userContent = p ? `[Audio: ${path.basename(p)}]` : '[Audio: dl failed]';
      break;
    }
    case 'location':
      userContent = `[Location: ${event.message.title || ''}, ${event.message.address || ''} (${event.message.latitude}, ${event.message.longitude})]`;
      break;
    case 'sticker':
      userContent = `[Sticker: ${event.message.packageId || ''} ${event.message.stickerId || ''}]`;
      break;
  }
  if (!userContent) return;

  // Get/create session
  let session = getSession(db, sessionId);
  if (!session) {
    const title = isGroup ? `LINE Group ${chatId.slice(0, 8)}` : `LINE ${sanitizedId.slice(0, 6)}`;
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
  saveMsg(db, sessionId, userMsg);
  session.messages.push(userMsg);

  // Show loading animation
  lineLoading(cfg.channelAccessToken, chatId);

  // Execute agent loop
  let fullContent = '';
  for await (const chunk of runtime.streamAgentLoop(session, userContent, {
    onAuditLog: (log) => {
      const auditId = Math.random().toString(36).substring(7);
      db.run(
        'INSERT INTO audit_logs (id, session_id, tool_name, input, output, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [auditId, sessionId, log.toolName, JSON.stringify(log.input), log.outputSummary, log.status, new Date().toISOString()]
      );
    }
  })) {
    if (chunk.text) fullContent += chunk.text;
    if (chunk.awaitingApproval) {
      const approvalId = Math.random().toString(36).substring(7);
      db.run(
        'INSERT INTO approvals (id, session_id, tool_name, input, risk_level, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [approvalId, sessionId, chunk.awaitingApproval.toolName, JSON.stringify(chunk.awaitingApproval.input), chunk.awaitingApproval.dangerLevel, chunk.awaitingApproval.reason, 'pending', new Date().toISOString()]
      );
      fullContent += `\n[Approval needed: ${chunk.awaitingApproval.toolName} - ${chunk.awaitingApproval.reason}]\nCheck pending approvals via CLI: ara approvals`;
    }
  }

  // Save assistant message
  const assistantMsg: Message = {
    id: Math.random().toString(36).substring(7),
    role: 'assistant',
    content: fullContent,
    createdAt: new Date(),
  };
  saveMsg(db, sessionId, assistantMsg);

  // Send reply
  if (!fullContent) fullContent = "Sorry, I couldn't compute a reply.";

  // Chunk at 5000 chars (LINE limit)
  const MAX = 5000;
  const msgs: any[] = [];
  for (let i = 0; i < fullContent.length; i += MAX) {
    msgs.push({ type: 'text', text: fullContent.slice(i, i + MAX) });
  }
  if (msgs.length === 0) msgs.push({ type: 'text', text: '...' });

  if (replyToken) {
    // Reply (max 5 messages per reply)
    await lineReply(cfg.channelAccessToken, replyToken, msgs.slice(0, 5));
    if (msgs.length > 5) {
      // Push remaining
      for (const batch of chunkArray(msgs.slice(5), 5)) {
        await linePush(cfg.channelAccessToken, chatId, batch);
      }
    }
  }
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

// ─── Webhook handler ────────────────────────────────────────────

export async function handleLineWebhook(
  body: string,
  signature: string | null,
  runtime: AgentRuntime,
  db: Database,
  onAutomation?: AutomationTrigger,
): Promise<{ ok: boolean; status: number; body: any }> {
  const cfg = loadConfig();
  if (!cfg.enabled || !cfg.channelAccessToken) {
    return { ok: false, status: 200, body: { ok: true, note: 'LINE not configured' } };
  }

  // Signature verification
  if (cfg.channelSecret && signature) {
    if (!verifySignature(body, signature, cfg.channelSecret)) {
      return { ok: false, status: 401, body: { error: 'Invalid signature' } };
    }
  }

  try {
    const parsed = JSON.parse(body);
    if (!parsed || !Array.isArray(parsed.events)) {
      return { ok: true, status: 200, body: { ok: true } };
    }

    for (const event of parsed.events) {
      handleEvent(event, cfg, runtime, db, onAutomation).catch(e =>
        console.error('LINE event error:', e)
      );
    }

    return { ok: true, status: 200, body: { ok: true } };
  } catch (e: any) {
    console.error('LINE webhook error:', e.message);
    return { ok: false, status: 500, body: { error: e.message } };
  }
}

export function getLineStatus(): { enabled: boolean; hasToken: boolean; groupPolicy: string } {
  const cfg = loadConfig();
  return {
    enabled: cfg.enabled && !!cfg.channelAccessToken,
    hasToken: !!cfg.channelAccessToken,
    groupPolicy: cfg.groupPolicy,
  };
}

// ─── Channel adapter ────────────────────────────────────────

export class LineChannel implements Channel {
  readonly name = "line";
  private _runtime: AgentRuntime;
  private _db: Database;
  private _onAutomation?: AutomationTrigger;

  constructor(runtime: AgentRuntime, db: Database, onAutomation?: AutomationTrigger) {
    this._runtime = runtime;
    this._db = db;
    this._onAutomation = onAutomation;
  }

  async start(): Promise<void> {} // LINE is webhook-driven, no background loop

  stop(): void {}

  status(): ChannelStatus {
    const s = getLineStatus();
    return { name: "line", running: s.enabled, healthy: s.enabled, info: { hasToken: s.hasToken, groupPolicy: s.groupPolicy } };
  }
}
