import { z } from 'zod';

export const NodeTypeSchema = z.enum([
  'chat', 'session', 'task', 'file', 'artifact', 'memory', 'skill',
  'subagent', 'github_issue', 'github_pr', 'mcp_tool', 'checkpoint', 'note',
]);
export type NodeType = z.infer<typeof NodeTypeSchema>;

export const EdgeTypeSchema = z.enum(['reference', 'dependency', 'result', 'action', 'context']);
export type EdgeType = z.infer<typeof EdgeTypeSchema>;

export interface CanvasPosition {
  x: number;
  y: number;
}

export interface CanvasSize {
  width: number;
  height: number;
}

export interface CanvasWorkspace {
  id: string;
  name: string;
  description?: string;
  projectRoot: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface CanvasNode {
  id: string;
  workspaceId: string;
  type: NodeType;
  title: string;
  description?: string;
  position: CanvasPosition;
  size?: CanvasSize;
  data: Record<string, unknown>;
  sourceRef?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CanvasEdge {
  id: string;
  workspaceId: string;
  fromNodeId: string;
  toNodeId: string;
  label?: string;
  type: EdgeType;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface CanvasExport {
  workspace: CanvasWorkspace;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  exportedAt: string;
}

export interface CanvasAction {
  id: string;
  workspaceId: string;
  action: string;
  nodeId: string;
  params: Record<string, unknown>;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: string;
  error?: string;
  createdAt: string;
}
