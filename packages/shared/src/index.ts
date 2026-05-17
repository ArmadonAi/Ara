import { z } from 'zod';

// Chat Session and Message Types
export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: Date;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: Message[];
  model: string;
  createdAt: Date;
  updatedAt: Date;
}

// Tool Types
export type ToolDangerLevel = 'safe' | 'write' | 'network' | 'dangerous';

export interface ToolContext {
  sessionId: string;
  userId: string;
  cwd: string;
  memoryAccess: any;
  auditLogger: any;
  approvalChecker: any;
}

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: any;
  dangerLevel: ToolDangerLevel;
  requiresApproval: boolean;
  run(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

// Memory Types
export type MemoryType = 'user' | 'project' | 'episodic' | 'procedural';

export interface Memory {
  id: string;
  type: MemoryType;
  title: string;
  content: string;
  source: string;
  tags: string[];
  confidence: number;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt?: Date;
}

// Skill Types
export interface Skill {
  name: string;
  description: string;
  tags: string[];
  whenToUse: string;
  inputs: string[];
  procedure: string[];
  output: string;
}

// Provider Types
export interface ChatChunk {
  text: string;
  isFinished: boolean;
  awaitingApproval?: {
    toolName: string;
    input: any;
    dangerLevel: string;
    reason: string;
  };
  blockedToolCall?: {
    toolName: string;
    reason: string;
  };
}

export interface ChatInput {
  messages: Message[];
  systemPrompt?: string;
  temperature?: number;
}

export interface LLMProvider {
  name: string;
  streamChat(input: ChatInput): AsyncIterable<ChatChunk>;
  generateText(input: ChatInput): Promise<string>;
  generateJSON<T>(input: ChatInput, schema: any): Promise<T>;
}

// Approval and Audit Log Types
export interface ApprovalRequest {
  id: string;
  sessionId: string;
  toolName: string;
  input: any;
  riskLevel: ToolDangerLevel;
  reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  createdAt: Date;
  resolvedAt?: Date;
}

export interface AuditLog {
  id: string;
  sessionId: string;
  toolName: string;
  input: any;
  outputSummary?: string;
  status: 'success' | 'failed';
  dangerLevel: ToolDangerLevel;
  approvalId?: string;
  startedAt: Date;
  finishedAt?: Date;
  error?: string;
}
