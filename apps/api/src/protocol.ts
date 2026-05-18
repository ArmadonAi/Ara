// ─── Ara WebSocket Protocol ──────────────────────────────────────
// Typed request/response/event protocol for real-time communication.
// Inspired by OpenClaw's gateway protocol but simplified.

// ─── Message types ──────────────────────────────────────────────

export interface WsRequest {
  type: 'req';
  id: string;
  method: string;
  params?: Record<string, any>;
}

export interface WsResponse {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: any;
  error?: string;
}

export interface WsEvent {
  type: 'event';
  event: string;
  payload: any;
  timestamp: string;
}

export type WsMessage = WsRequest | WsResponse | WsEvent;

// ─── Method handler registry ────────────────────────────────────

type MethodHandler = (params: any) => Promise<any> | any;

const handlers = new Map<string, MethodHandler>();

export function registerMethod(method: string, handler: MethodHandler) {
  handlers.set(method, handler);
}

export async function handleRequest(req: WsRequest): Promise<WsResponse> {
  const handler = handlers.get(req.method);
  if (!handler) {
    return { type: 'res', id: req.id, ok: false, error: `Unknown method: ${req.method}` };
  }
  try {
    const result = await handler(req.params);
    return { type: 'res', id: req.id, ok: true, payload: result };
  } catch (e: any) {
    return { type: 'res', id: req.id, ok: false, error: e.message };
  }
}

export function createEvent(event: string, payload: any): WsEvent {
  return { type: 'event', event, payload, timestamp: new Date().toISOString() };
}
