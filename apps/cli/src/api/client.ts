import { getApiBaseUrl } from '../config/manager';

export interface ApiStatus {
  status: string;
  version: string;
  database: string;
  pendingApprovalsCount: number;
  skillsCount: number;
  sandboxMode: boolean;
  memoryEnabled: boolean;
  activePermissionMode?: string;
}

export interface ChatSession {
  id: string;
  title: string;
  model: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  messages?: ChatMessage[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
}

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  toolName: string;
  input: string;
  riskLevel: 'safe' | 'write' | 'network' | 'dangerous';
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
}

export interface AuditLog {
  id: string;
  sessionId: string;
  toolName: string;
  input: string;
  output: string;
  status: 'success' | 'failed' | 'pending';
  createdAt: string;
}

export interface Skill {
  name: string;
  description: string;
  dangerLevel: string;
}

export interface Memory {
  id: string;
  type: 'user' | 'project' | 'episodic';
  title: string;
  content: string;
}

export interface ModelOption {
  id: string;
  name: string;
  provider: string;
}

// Structured SSE Stream events
export type StreamEvent =
  | { type: 'message.delta'; text: string }
  | { type: 'message.done' }
  | { type: 'tool.started'; name: string; input?: string }
  | { type: 'tool.finished'; name: string; output?: string }
  | { type: 'tool.failed'; name: string; error?: string }
  | { type: 'approval.required'; approvalId?: string; toolName: string; riskLevel: string; reason: string }
  | { type: 'error'; message: string };

export class ApiClient {
  private get baseUrl(): string {
    return getApiBaseUrl();
  }

  async getStatus(): Promise<ApiStatus> {
    const res = await fetch(`${this.baseUrl}/api/status`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async listSessions(): Promise<ChatSession[]> {
    const res = await fetch(`${this.baseUrl}/api/sessions`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async getSession(id: string): Promise<ChatSession> {
    const res = await fetch(`${this.baseUrl}/api/sessions/${id}`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async createSession(model: string = 'Gemini', title?: string): Promise<ChatSession> {
    const res = await fetch(`${this.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, title })
    });
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async sendMessage(sessionId: string, content: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
  }

  // SSE Stream generator that decodes the Hono raw streaming text and yields structured events
  async *streamMessage(sessionId: string, content: string): AsyncGenerator<StreamEvent, void, unknown> {
    const res = await fetch(`${this.baseUrl}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });

    if (!res.ok) {
      yield { type: 'error', message: `API Server returned error status ${res.status}` };
      return;
    }

    const reader = res.body?.getReader();
    if (!reader) {
      yield { type: 'error', message: 'Readable stream is not supported by host' };
      return;
    }

    const decoder = new TextDecoder();
    let accumulatedText = '';
    let inToolCall = false;
    let currentToolName = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const textChunk = decoder.decode(value);
        accumulatedText += textChunk;

        // Yield standard text tokens
        yield { type: 'message.delta', text: textChunk };

        // Parse tool calls live (using simple regex checks on accumulated text)
        if (!inToolCall) {
          const toolCallMatch = accumulatedText.match(/<tool_call\s+name="([^"]+)">([\s\S]*?)$/i);
          if (toolCallMatch && toolCallMatch[1]) {
            inToolCall = true;
            currentToolName = toolCallMatch[1];
            yield { 
              type: 'tool.started', 
              name: currentToolName, 
              input: toolCallMatch[2]?.trim() 
            };
          }
        } else {
          // Check if tool call finished
          if (accumulatedText.includes('</tool_call>')) {
            inToolCall = false;
            yield { type: 'tool.finished', name: currentToolName };
          }
        }

        // TUI approval gates
        if (textChunk.includes('awaitingApproval') || textChunk.includes('requires manual user approval')) {
          yield {
            type: 'approval.required',
            toolName: currentToolName || 'write_file',
            riskLevel: 'dangerous',
            reason: 'Tool execution requires user verification.'
          };
        }
      }

      yield { type: 'message.done' };
    } catch (e: any) {
      yield { type: 'error', message: e.message || 'Stream exception' };
    } finally {
      reader.releaseLock();
    }
  }

  async listApprovals(): Promise<ApprovalRequest[]> {
    const res = await fetch(`${this.baseUrl}/api/approvals`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async approveRequest(id: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/approvals/${id}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve' })
    });
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async rejectRequest(id: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/approvals/${id}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reject' })
    });
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async listMemory(): Promise<Memory[]> {
    const res = await fetch(`${this.baseUrl}/api/memories`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async searchMemory(query: string): Promise<Memory[]> {
    const memories = await this.listMemory();
    const lc = query.toLowerCase();
    return memories.filter(m => 
      m.title.toLowerCase().includes(lc) || 
      m.content.toLowerCase().includes(lc)
    );
  }

  async listSkills(): Promise<Skill[]> {
    const res = await fetch(`${this.baseUrl}/api/skills`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async loadSkill(name: string): Promise<Skill | undefined> {
    const skills = await this.listSkills();
    return skills.find(s => s.name === name);
  }

  async listTools(): Promise<string[]> {
    // Return registered tool signatures directly
    return ['list_files', 'read_file', 'write_file', 'run_shell', 'git_status', 'git_diff'];
  }

  async listAuditLogs(): Promise<AuditLog[]> {
    const res = await fetch(`${this.baseUrl}/api/audit-logs`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async compactSession(sessionId: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/sessions/${sessionId}/compact`, {
      method: 'POST'
    });
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async forkSession(sessionId: string, messageIndex: number): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/sessions/${sessionId}/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageIndex })
    });
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async resumeSession(sessionId: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/sessions/${sessionId}/resume`, {
      method: 'POST'
    });
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async updateModelConfig(newModel: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultModel: newModel })
    });
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }
}
