import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { CanvasWorkspace, CanvasNode, CanvasEdge } from './types';

const CANVAS_DIR = '.ara/canvas/workspaces';

function getWorkspacePath(cwd: string, id: string): string {
  return path.join(cwd, CANVAS_DIR, `${id}.json`);
}

function getWorkspacesDir(cwd: string): string {
  return path.join(cwd, CANVAS_DIR);
}

async function ensureDir(dir: string): Promise<void> {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    // already exists
  }
}

interface WorkspaceFile {
  workspace: CanvasWorkspace;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

async function readWorkspaceFile(filePath: string): Promise<WorkspaceFile | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as WorkspaceFile;
  } catch {
    return null;
  }
}

async function writeWorkspaceFile(filePath: string, data: WorkspaceFile): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// ── Workspace CRUD ────────────────────────────────────────────────

export async function createWorkspace(
  workspace: CanvasWorkspace,
  cwd: string = process.cwd(),
): Promise<CanvasWorkspace> {
  const dir = getWorkspacesDir(cwd);
  await ensureDir(dir);
  const filePath = getWorkspacePath(cwd, workspace.id);
  const data: WorkspaceFile = { workspace, nodes: [], edges: [] };
  await writeWorkspaceFile(filePath, data);
  return workspace;
}

export async function listWorkspaces(cwd: string = process.cwd()): Promise<CanvasWorkspace[]> {
  const dir = getWorkspacesDir(cwd);
  try {
    const files = await fs.readdir(dir);
    const workspaces: CanvasWorkspace[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const data = await readWorkspaceFile(path.join(dir, file));
      if (data) workspaces.push(data.workspace);
    }
    return workspaces.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  } catch {
    return [];
  }
}

export async function getWorkspace(id: string, cwd: string = process.cwd()): Promise<CanvasWorkspace | null> {
  const data = await readWorkspaceFile(getWorkspacePath(cwd, id));
  return data?.workspace || null;
}

export async function updateWorkspace(
  id: string, updates: Partial<CanvasWorkspace>,
  cwd: string = process.cwd(),
): Promise<CanvasWorkspace | null> {
  const filePath = getWorkspacePath(cwd, id);
  const data = await readWorkspaceFile(filePath);
  if (!data) return null;
  data.workspace = { ...data.workspace, ...updates, updatedAt: new Date().toISOString() };
  await writeWorkspaceFile(filePath, data);
  return data.workspace;
}

export async function deleteWorkspace(id: string, cwd: string = process.cwd()): Promise<boolean> {
  const filePath = getWorkspacePath(cwd, id);
  try {
    await fs.unlink(filePath);
    return true;
  } catch {
    return false;
  }
}

// ── Node CRUD ─────────────────────────────────────────────────────

export async function addNode(workspaceId: string, node: CanvasNode, cwd: string = process.cwd()): Promise<CanvasNode | null> {
  const filePath = getWorkspacePath(cwd, workspaceId);
  const data = await readWorkspaceFile(filePath);
  if (!data) return null;
  data.nodes.push(node);
  data.workspace.updatedAt = new Date().toISOString();
  await writeWorkspaceFile(filePath, data);
  return node;
}

export async function updateNode(
  workspaceId: string, nodeId: string, updates: Partial<CanvasNode>,
  cwd: string = process.cwd(),
): Promise<CanvasNode | null> {
  const filePath = getWorkspacePath(cwd, workspaceId);
  const data = await readWorkspaceFile(filePath);
  if (!data) return null;
  const idx = data.nodes.findIndex(n => n.id === nodeId);
  if (idx === -1) return null;
  data.nodes[idx] = { ...data.nodes[idx], ...updates, updatedAt: new Date().toISOString() };
  data.workspace.updatedAt = new Date().toISOString();
  await writeWorkspaceFile(filePath, data);
  return data.nodes[idx];
}

export async function deleteNode(workspaceId: string, nodeId: string, cwd: string = process.cwd()): Promise<boolean> {
  const filePath = getWorkspacePath(cwd, workspaceId);
  const data = await readWorkspaceFile(filePath);
  if (!data) return false;
  const idx = data.nodes.findIndex(n => n.id === nodeId);
  if (idx === -1) return false;
  data.nodes.splice(idx, 1);
  // Also remove edges referencing this node
  data.edges = data.edges.filter(e => e.fromNodeId !== nodeId && e.toNodeId !== nodeId);
  data.workspace.updatedAt = new Date().toISOString();
  await writeWorkspaceFile(filePath, data);
  return true;
}

export async function queryNodes(
  workspaceId: string,
  filter?: { type?: string; sourceRef?: string },
  cwd: string = process.cwd(),
): Promise<CanvasNode[]> {
  const data = await readWorkspaceFile(getWorkspacePath(cwd, workspaceId));
  if (!data) return [];
  let nodes = data.nodes;
  if (filter?.type) nodes = nodes.filter(n => n.type === filter.type);
  if (filter?.sourceRef) nodes = nodes.filter(n => n.sourceRef === filter.sourceRef);
  return nodes;
}

export async function getAllNodes(workspaceId: string, cwd: string = process.cwd()): Promise<CanvasNode[]> {
  const data = await readWorkspaceFile(getWorkspacePath(cwd, workspaceId));
  return data?.nodes || [];
}

// ── Edge CRUD ─────────────────────────────────────────────────────

export async function addEdge(workspaceId: string, edge: CanvasEdge, cwd: string = process.cwd()): Promise<CanvasEdge | null> {
  const filePath = getWorkspacePath(cwd, workspaceId);
  const data = await readWorkspaceFile(filePath);
  if (!data) return null;
  // Validate both nodes exist
  const fromExists = data.nodes.some(n => n.id === edge.fromNodeId);
  const toExists = data.nodes.some(n => n.id === edge.toNodeId);
  if (!fromExists || !toExists) return null;
  data.edges.push(edge);
  data.workspace.updatedAt = new Date().toISOString();
  await writeWorkspaceFile(filePath, data);
  return edge;
}

export async function deleteEdge(workspaceId: string, edgeId: string, cwd: string = process.cwd()): Promise<boolean> {
  const filePath = getWorkspacePath(cwd, workspaceId);
  const data = await readWorkspaceFile(filePath);
  if (!data) return false;
  const idx = data.edges.findIndex(e => e.id === edgeId);
  if (idx === -1) return false;
  data.edges.splice(idx, 1);
  data.workspace.updatedAt = new Date().toISOString();
  await writeWorkspaceFile(filePath, data);
  return true;
}

export async function getAllEdges(workspaceId: string, cwd: string = process.cwd()): Promise<CanvasEdge[]> {
  const data = await readWorkspaceFile(getWorkspacePath(cwd, workspaceId));
  return data?.edges || [];
}

// ── Full workspace data ────────────────────────────────────────────

export async function getFullWorkspace(id: string, cwd: string = process.cwd()): Promise<{ workspace: CanvasWorkspace | null; nodes: CanvasNode[]; edges: CanvasEdge[] }> {
  const data = await readWorkspaceFile(getWorkspacePath(cwd, id));
  if (!data) return { workspace: null, nodes: [], edges: [] };
  return data;
}
