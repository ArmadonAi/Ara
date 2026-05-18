// ─── Ara Gateway ────────────────────────────────────────────────
// WebSocket gateway that manages channel lifecycle, real-time events,
// and provides a unified interface for messaging channels.

import type { Channel, ChannelStatus } from './channel';
import type { WsRequest } from './protocol';
import { handleRequest, createEvent } from './protocol';

interface WsClient {
  id: string;
  socket: WebSocket;
}

export class Gateway {
  private channels: Map<string, Channel> = new Map();
  private clients: Map<string, WsClient> = new Map();
  private running = false;

  // ─── Channel management ───────────────────────────────────────

  register(channel: Channel) {
    this.channels.set(channel.name, channel);
  }

  async startAll(): Promise<void> {
    for (const [name, ch] of this.channels) {
      try {
        await ch.start();
        console.log(`Gateway: channel "${name}" started`);
      } catch (e: any) {
        console.error(`Gateway: channel "${name}" failed to start:`, e.message);
      }
    }
  }

  stopAll(): void {
    for (const [name, ch] of this.channels) {
      ch.stop();
      console.log(`Gateway: channel "${name}" stopped`);
    }
    this.running = false;
  }

  getStatus(): ChannelStatus[] {
    const result: ChannelStatus[] = [];
    for (const [, ch] of this.channels) {
      result.push(ch.status());
    }
    return result;
  }

  getChannel(name: string): Channel | undefined {
    return this.channels.get(name);
  }

  // ─── WebSocket handler ─────────────────────────────────────────

  handleWsUpgrade(socket: WebSocket): void {
    const id = `ws_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const client: WsClient = { id, socket };
    this.clients.set(id, client);

    // Send initial status
    socket.send(JSON.stringify(createEvent('gateway.status', {
      channels: this.getStatus(),
      clientId: id,
    })));

    // Handle incoming messages
    socket.addEventListener('message', async (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(ev.data as string) as WsRequest;
        if (msg.type === 'req') {
          const res = await handleRequest(msg);
          socket.send(JSON.stringify(res));
        }
      } catch {}
    });

    socket.addEventListener('close', () => {
      this.clients.delete(id);
    });

    socket.addEventListener('error', () => {
      this.clients.delete(id);
    });
  }

  // ─── Broadcast events to all WS clients ───────────────────────

  broadcast(event: string, payload: any): void {
    const msg = JSON.stringify(createEvent(event, payload));
    for (const [, client] of this.clients) {
      try { client.socket.send(msg); } catch {}
    }
  }
}

// Singleton
let instance: Gateway | null = null;

export function getGateway(): Gateway {
  if (!instance) instance = new Gateway();
  return instance;
}

export function resetGateway(): void {
  if (instance) instance.stopAll();
  instance = null;
}
