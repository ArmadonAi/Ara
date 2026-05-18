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

  async getConfigKeys(): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/config/keys`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async setConfigKeys(keys: Record<string, string>): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/config/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(keys)
    });
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async listSubagents(): Promise<any[]> {
    const res = await fetch(`${this.baseUrl}/api/subagents`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async getSubagent(name: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/subagents/${name}`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async runSubagent(profileName: string, task: string, context?: string, parentSessionId?: string, allowedTools?: string[], maxTurns?: number): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/subagents/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileName, task, context, parentSessionId, allowedTools, maxTurns })
    });
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async listSubagentRuns(): Promise<any[]> {
    const res = await fetch(`${this.baseUrl}/api/subagents/runs`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async getSubagentRun(id: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/subagents/runs/${id}`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async cancelSubagentRun(id: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/subagents/runs/${id}/cancel`, {
      method: 'POST'
    });
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async getSessionSubagentRuns(sessionId: string): Promise<any[]> {
    const res = await fetch(`${this.baseUrl}/api/sessions/${sessionId}/subagent-runs`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async listCheckpoints(): Promise<any[]> {
    const res = await fetch(`${this.baseUrl}/api/checkpoints`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async listSessionCheckpoints(sessionId: string): Promise<any[]> {
    const res = await fetch(`${this.baseUrl}/api/sessions/${sessionId}/checkpoints`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async createCheckpoint(sessionId: string, reason: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/sessions/${sessionId}/checkpoints`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason })
    });
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async getCheckpoint(id: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/checkpoints/${id}`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async diffCheckpoint(id: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/checkpoints/${id}/diff`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async restoreCheckpoint(id: string, mode: 'code_only' | 'conversation_only' | 'both'): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/checkpoints/${id}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode })
    });
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  // ── MCP Client Methods ────────────────────────────────────────────

  async getMcpOverview(): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/mcp`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async listMcpServers(): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/mcp/servers`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async getMcpServer(id: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/mcp/servers/${id}`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async startMcpServer(id: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/mcp/servers/${id}/start`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async stopMcpServer(id: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/mcp/servers/${id}/stop`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async restartMcpServer(id: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/mcp/servers/${id}/restart`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async reconnectMcpServer(id: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/mcp/servers/${id}/reconnect`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async listMcpTools(serverId?: string): Promise<any> {
    const url = serverId
      ? `${this.baseUrl}/api/mcp/servers/${serverId}/tools`
      : `${this.baseUrl}/api/mcp/tools`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async callMcpTool(fullToolName: string, input: Record<string, unknown>, sessionId: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/mcp/tools/${encodeURIComponent(fullToolName)}/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, input })
    });
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async getMcpHealth(): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/mcp/health`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async refreshMcpTools(serverId?: string): Promise<any> {
    const url = serverId
      ? `${this.baseUrl}/api/mcp/servers/${serverId}/tools/refresh`
      : `${this.baseUrl}/api/mcp/tools/refresh`;
    const res = await fetch(url, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async validateMcpConfig(config: any): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/mcp/config/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  // ── GitHub Client Methods ───────────────────────────────────────

  async getGitHubOverview(): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/github`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async getGitHubStatus(): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/github/status`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async callGitHubTool(toolPath: string, params: Record<string, unknown>, sessionId: string = 'cli'): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/github/${toolPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...params, sessionId })
    });
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async getGitHubRepo(owner: string, repo: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/github/repos/${owner}/${repo}`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async getGitHubIssues(owner: string, repo: string, page?: number, perPage?: number): Promise<any> {
    const params = new URLSearchParams();
    if (page) params.set('page', String(page));
    if (perPage) params.set('per_page', String(perPage));
    const qs = params.toString() ? '?' + params.toString() : '';
    const res = await fetch(`${this.baseUrl}/api/github/repos/${owner}/${repo}/issues${qs}`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async getGitHubIssue(owner: string, repo: string, issueNumber: number): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/github/repos/${owner}/${repo}/issues/${issueNumber}`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async getGitHubPRs(owner: string, repo: string, page?: number, perPage?: number): Promise<any> {
    const params = new URLSearchParams();
    if (page) params.set('page', String(page));
    if (perPage) params.set('per_page', String(perPage));
    const qs = params.toString() ? '?' + params.toString() : '';
    const res = await fetch(`${this.baseUrl}/api/github/repos/${owner}/${repo}/pulls${qs}`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async getGitHubPR(owner: string, repo: string, pullNumber: number): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/github/repos/${owner}/${repo}/pulls/${pullNumber}`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async getGitHubPRFiles(owner: string, repo: string, pullNumber: number): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/github/repos/${owner}/${repo}/pulls/${pullNumber}/files`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async getGitHubPRDiff(owner: string, repo: string, pullNumber: number): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/github/repos/${owner}/${repo}/pulls/${pullNumber}/diff`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async getGitHubChecks(owner: string, repo: string, ref: string, page?: number, perPage?: number): Promise<any> {
    const params = new URLSearchParams();
    if (page) params.set('page', String(page));
    if (perPage) params.set('per_page', String(perPage));
    const qs = params.toString() ? '?' + params.toString() : '';
    const res = await fetch(`${this.baseUrl}/api/github/repos/${owner}/${repo}/check-runs/${ref}${qs}`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async getGitHubWorkflowRuns(owner: string, repo: string, page?: number, perPage?: number): Promise<any> {
    const params = new URLSearchParams();
    if (page) params.set('page', String(page));
    if (perPage) params.set('per_page', String(perPage));
    const qs = params.toString() ? '?' + params.toString() : '';
    const res = await fetch(`${this.baseUrl}/api/github/repos/${owner}/${repo}/actions/runs${qs}`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  // ── GitHub Write Methods ──────────────────────────────────────────

  async createGitHubIssue(owner: string, repo: string, title: string, body?: string, labels?: string[], sessionId: string = 'cli'): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/github/repos/${owner}/${repo}/issues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body, labels, sessionId })
    });
    return res.json() as any;
  }

  async commentGitHubIssue(owner: string, repo: string, issueNumber: number, body: string, sessionId: string = 'cli'): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/github/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body, sessionId })
    });
    return res.json() as any;
  }

  // ── Lock Methods ──────────────────────────────────────────────

  async listLocks(status?: string): Promise<any> {
    const params = status ? `?status=${status}` : '';
    const res = await fetch(`${this.baseUrl}/api/locks${params}`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async acquireLock(path: string, mode: string, sessionId: string = 'cli', ttlMs?: number): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/locks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, path, mode, ttlMs })
    });
    return res.json() as any;
  }

  async releaseLock(lockId: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/locks/${lockId}/release`, { method: 'POST' });
    return res.json() as any;
  }

  async forceReleaseLock(lockId: string, reason: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/locks/${lockId}/force-release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason })
    });
    return res.json() as any;
  }

  async cleanupLocks(): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/locks/cleanup`, { method: 'POST' });
    return res.json() as any;
  }

  async getLockAudit(limit?: number): Promise<any> {
    const params = limit ? `?limit=${limit}` : '';
    const res = await fetch(`${this.baseUrl}/api/locks/audit${params}`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  // ── Parallel Subagent Methods ─────────────────────────────────

  async startParallelRun(profiles: string[], sessionId: string, maxConcurrency?: number): Promise<any> {
    const profileObjects = profiles.map(name => ({ name, task: `Parallel subagent: ${name}` }));
    const res = await fetch(`${this.baseUrl}/api/subagents/parallel-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profiles: profileObjects, sessionId, maxConcurrency })
    });
    return res.json() as any;
  }

  async listParallelRuns(): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/subagents/parallel-runs`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async getParallelRun(id: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/subagents/parallel-runs/${id}`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async cancelParallelRun(id: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/subagents/parallel-runs/${id}/cancel`, { method: 'POST' });
    return res.json() as any;
  }

  // ── Canvas Methods ────────────────────────────────────────────

  // ── Skill Learning Methods ─────────────────────────────────────

  async getSkillLearningOverview(): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/skill-learning`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async getSkillLearningWorkflows(threshold?: number): Promise<any> {
    const params = threshold ? `?threshold=${threshold}` : '';
    const res = await fetch(`${this.baseUrl}/api/skill-learning/workflows${params}`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async analyzeSessionByApi(sessionId: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/skill-learning/analyze/session/${sessionId}`, { method: 'POST' });
    return res.json() as any;
  }

  async analyzeRecentByApi(limit?: number): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/skill-learning/analyze/recent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: limit || 10 }),
    });
    return res.json() as any;
  }

  async analyzeSkillLearning(goal: string, toolSequence: string[], filesTouched?: string[]): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/skill-learning/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal, toolSequence, filesTouched })
    });
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async listSkillDrafts(): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/skill-learning/drafts`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async getSkillDraft(id: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/skill-learning/drafts/${id}`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async approveSkillDraft(id: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/skill-learning/drafts/${id}/approve`, { method: 'POST' });
    return res.json() as any;
  }

  async rejectSkillDraft(id: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/skill-learning/drafts/${id}/reject`, { method: 'POST' });
    return res.json() as any;
  }

  async diffSkillDraft(id: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/skill-learning/drafts/${id}/diff`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async getSkillLearningStats(): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/skill-learning/stats`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async listCanvasWorkspaces(): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/canvas/workspaces`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async createCanvasWorkspace(name: string, description?: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/canvas/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description })
    });
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async getCanvasWorkspace(id: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/canvas/workspaces/${id}`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async updateCanvasWorkspace(id: string, patch: any): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/canvas/workspaces/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    });
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async deleteCanvasWorkspace(id: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/canvas/workspaces/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async addCanvasNode(workspaceId: string, input: any): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/canvas/workspaces/${workspaceId}/nodes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input)
    });
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async updateCanvasNode(workspaceId: string, nodeId: string, patch: any): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/canvas/workspaces/${workspaceId}/nodes/${nodeId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    });
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async deleteCanvasNode(workspaceId: string, nodeId: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/canvas/workspaces/${workspaceId}/nodes/${nodeId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async addCanvasEdge(workspaceId: string, input: any): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/canvas/workspaces/${workspaceId}/edges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input)
    });
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async deleteCanvasEdge(workspaceId: string, edgeId: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/canvas/workspaces/${workspaceId}/edges/${edgeId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async exportCanvasWorkspace(id: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/canvas/workspaces/${id}/export`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async executeCanvasAction(workspaceId: string, action: string, nodeId: string, params?: any): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/canvas/workspaces/${workspaceId}/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, nodeId, params: params || {} })
    });
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async createGitHubPRReview(owner: string, repo: string, pullNumber: number, body: string, event: string = 'COMMENT', sessionId: string = 'cli'): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/github/repos/${owner}/${repo}/pulls/${pullNumber}/reviews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body, event, sessionId })
    });
    return res.json() as any;
  }

  async getMcpAudit(serverId?: string, sessionId?: string, limit?: number): Promise<any> {
    const params = new URLSearchParams();
    if (serverId) params.set('serverId', serverId);
    if (sessionId) params.set('sessionId', sessionId);
    if (limit) params.set('limit', String(limit));
    const res = await fetch(`${this.baseUrl}/api/mcp/audit?${params.toString()}`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  // ── Codex Methods ────────────────────────────────────────────

  async startCodex(binary?: string, prompt?: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/codex/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ binary, prompt }),
    });
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async sendCodex(id: string, input: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/codex/${encodeURIComponent(id)}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
    });
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async getCodexOutput(id: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/codex/${encodeURIComponent(id)}/output`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async stopCodex(id: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/codex/${encodeURIComponent(id)}/stop`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async listCodexSessions(): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/codex/sessions`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  // ── Gateway Methods ───────────────────────────────────────────

  async getGatewayStatus(): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/gateway/status`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async restartGatewayChannel(name: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/gateway/channels/${encodeURIComponent(name)}/restart`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }

  async stopGatewayChannel(name: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/gateway/channels/${encodeURIComponent(name)}/stop`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return res.json() as any;
  }
}
