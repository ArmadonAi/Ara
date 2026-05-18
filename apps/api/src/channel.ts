// ─── Channel Interface ──────────────────────────────────────────
// Standard contract for all messaging channels (Telegram, LINE, etc.)

export interface ChannelStatus {
  name: string;
  running: boolean;
  healthy: boolean;
  info: Record<string, any>;
}

export interface MessageEvent {
  channel: string;
  sessionId: string;
  userId: string;
  content: string;
  replyToken?: string;
}

export interface Channel {
  readonly name: string;
  start(): Promise<void>;
  stop(): void;
  status(): ChannelStatus;
}

export type AutomationTrigger = (channel: string, userId: string, text: string) => boolean;
