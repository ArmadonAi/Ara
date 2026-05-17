import { z } from 'zod';
import type { PermissionMode } from '@ara/permissions';

export interface SubagentResult {
  summary: string;
  findings: string[];
  artifacts: string[];
  nextActions: string[];
}

export type SubagentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface SubagentRun {
  id: string;
  parentSessionId: string;
  childSessionId: string;
  profileName: string;
  task: string;
  context: string;
  allowedTools: string[];
  permissionMode: PermissionMode;
  status: SubagentStatus;
  result?: SubagentResult;
  error?: string;
  maxTurns?: number;
  createdAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
}

export type ParallelStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface ParallelSubagentRun {
  id: string;
  parentSessionId: string;
  parentTask: string;
  profiles: { name: string; task: string }[];
  status: ParallelStatus;
  results: SubagentRunResult[];
  maxConcurrency: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  cancelledChildren?: string[];
}

export interface SubagentRunResult {
  runId: string;
  profileName: string;
  status: SubagentStatus;
  summary?: string;
  error?: string;
}

export interface SubagentProfile {
  name: string;
  description: string;
  model: string;
  permissionMode: PermissionMode;
  maxTurns: number;
  tools: string[];
  tags: string[];
  systemPrompt: string;
}
