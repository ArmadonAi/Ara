import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createWorkspace, listWorkspaces, getWorkspace, updateWorkspace, deleteWorkspace, addNode, updateNode, deleteNode, addEdge, deleteEdge, getAllNodes, getAllEdges } from '../src/canvasStore';
import { createChatNode, createFileNode, createGitHubIssueNode, createMcpToolNode, createNoteNode } from '../src/nodeFactory';
import { createEdge } from '../src/edgeFactory';
import { exportCanvas } from '../src/canvasExport';
import { resolveActionSafety, executeSafeAction } from '../src/canvasActions';
import { writeCanvasAudit, listCanvasAudit, clearCanvasAudit } from '../src/canvasAudit';
import type { CanvasWorkspace, CanvasNode } from '../src/types';

const TEST_DIR = '/tmp/ara-canvas-test';
const testCwd = TEST_DIR;

describe('canvas workspace CRUD', () => {
  beforeEach(async () => {
    try { await fs.rm(TEST_DIR, { recursive: true, force: true }); } catch {}
    await fs.mkdir(path.join(TEST_DIR, '.ara', 'canvas', 'workspaces'), { recursive: true });
  });

  afterAll(async () => {
    try { await fs.rm(TEST_DIR, { recursive: true, force: true }); } catch {}
  });

  it('creates a workspace', async () => {
    const ws: CanvasWorkspace = {
      id: 'ws-1', name: 'Test', projectRoot: TEST_DIR,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const result = await createWorkspace(ws, testCwd);
    expect(result.id).toBe('ws-1');
  });

  it('lists workspaces', async () => {
    const ws: CanvasWorkspace = {
      id: 'ws-2', name: 'Test 2', projectRoot: TEST_DIR,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    await createWorkspace(ws, testCwd);
    const list = await listWorkspaces(testCwd);
    expect(list.length).toBe(1);
    expect(list[0].id).toBe('ws-2');
  });

  it('gets a workspace', async () => {
    const ws: CanvasWorkspace = {
      id: 'ws-3', name: 'Test 3', projectRoot: TEST_DIR,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    await createWorkspace(ws, testCwd);
    const got = await getWorkspace('ws-3', testCwd);
    expect(got).not.toBeNull();
    expect(got!.name).toBe('Test 3');
  });

  it('updates a workspace', async () => {
    const ws: CanvasWorkspace = {
      id: 'ws-4', name: 'Original', projectRoot: TEST_DIR,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    await createWorkspace(ws, testCwd);
    const updated = await updateWorkspace('ws-4', { name: 'Updated' }, testCwd);
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe('Updated');
  });

  it('deletes a workspace', async () => {
    const ws: CanvasWorkspace = {
      id: 'ws-5', name: 'Delete me', projectRoot: TEST_DIR,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    await createWorkspace(ws, testCwd);
    const ok = await deleteWorkspace('ws-5', testCwd);
    expect(ok).toBe(true);
    const got = await getWorkspace('ws-5', testCwd);
    expect(got).toBeNull();
  });
});

describe('canvas nodes', () => {
  const wsId = 'node-test-ws';
  beforeEach(async () => {
    try { await fs.rm(TEST_DIR, { recursive: true, force: true }); } catch {}
    await fs.mkdir(path.join(TEST_DIR, '.ara', 'canvas', 'workspaces'), { recursive: true });
    await createWorkspace({ id: wsId, name: 'Node Test', projectRoot: TEST_DIR, createdAt: '', updatedAt: '' }, testCwd);
  });

  it('adds a node', async () => {
    const node = createNoteNode(wsId, 'My Note', 'Hello');
    const result = await addNode(wsId, node, testCwd);
    expect(result).not.toBeNull();
    expect(result!.title).toBe('My Note');
  });

  it('updates a node', async () => {
    const node = createNoteNode(wsId, 'Original', 'Content');
    await addNode(wsId, node, testCwd);
    const updated = await updateNode(wsId, node.id, { title: 'Updated' }, testCwd);
    expect(updated).not.toBeNull();
    expect(updated!.title).toBe('Updated');
  });

  it('deletes a node', async () => {
    const node = createNoteNode(wsId, 'Delete me', '');
    await addNode(wsId, node, testCwd);
    const ok = await deleteNode(wsId, node.id, testCwd);
    expect(ok).toBe(true);
    const nodes = await getAllNodes(wsId, testCwd);
    expect(nodes.length).toBe(0);
  });

  it('creates file node without secrets', () => {
    const node = createFileNode(wsId, 'src/index.ts');
    expect(node.type).toBe('file');
    expect(node.sourceRef).toBe('file:src/index.ts');
    expect(node.data.filePath).toBe('src/index.ts');
    // No secrets in data
    expect(Object.keys(node.data)).not.toContain('content');
    expect(Object.keys(node.data)).not.toContain('token');
  });

  it('creates GitHub issue node', () => {
    const node = createGitHubIssueNode(wsId, 'owner', 'repo', 42, 'Fix bug');
    expect(node.type).toBe('github_issue');
    expect(node.sourceRef).toBe('github_issue:owner/repo#42');
    expect(node.data.issueNumber).toBe(42);
  });

  it('creates MCP tool node', () => {
    const node = createMcpToolNode(wsId, 'mcp.fs.read_file', 'fs', 'read_file');
    expect(node.type).toBe('mcp_tool');
    expect(node.data.fullToolName).toBe('mcp.fs.read_file');
  });
});

describe('canvas edges', () => {
  const wsId = 'edge-test-ws';
  beforeEach(async () => {
    try { await fs.rm(TEST_DIR, { recursive: true, force: true }); } catch {}
    await fs.mkdir(path.join(TEST_DIR, '.ara', 'canvas', 'workspaces'), { recursive: true });
    await createWorkspace({ id: wsId, name: 'Edge Test', projectRoot: TEST_DIR, createdAt: '', updatedAt: '' }, testCwd);
  });

  it('adds an edge between existing nodes', async () => {
    const n1 = createNoteNode(wsId, 'A', '');
    const n2 = createNoteNode(wsId, 'B', '');
    await addNode(wsId, n1, testCwd);
    await addNode(wsId, n2, testCwd);
    const edge = createEdge(wsId, n1.id, n2.id, 'reference', 'connects to');
    const result = await addEdge(wsId, edge, testCwd);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('reference');
  });

  it('rejects edge with missing node', async () => {
    const n1 = createNoteNode(wsId, 'A', '');
    await addNode(wsId, n1, testCwd);
    const edge = createEdge(wsId, n1.id, 'nonexistent-node', 'reference');
    const result = await addEdge(wsId, edge, testCwd);
    expect(result).toBeNull();
  });

  it('deletes an edge', async () => {
    const n1 = createNoteNode(wsId, 'A', '');
    const n2 = createNoteNode(wsId, 'B', '');
    await addNode(wsId, n1, testCwd);
    await addNode(wsId, n2, testCwd);
    const edge = createEdge(wsId, n1.id, n2.id);
    await addEdge(wsId, edge, testCwd);
    const ok = await deleteEdge(wsId, edge.id, testCwd);
    expect(ok).toBe(true);
    const edges = await getAllEdges(wsId, testCwd);
    expect(edges.length).toBe(0);
  });
});

describe('canvas export', () => {
  it('exports a workspace', async () => {
    try { await fs.rm(TEST_DIR, { recursive: true, force: true }); } catch {}
    await fs.mkdir(path.join(TEST_DIR, '.ara', 'canvas', 'workspaces'), { recursive: true });
    await createWorkspace({ id: 'export-ws', name: 'Export', projectRoot: TEST_DIR, createdAt: '', updatedAt: '' }, testCwd);
    const node = createNoteNode('export-ws', 'Exported', 'data');
    await addNode('export-ws', node, testCwd);
    const exported = await exportCanvas('export-ws', testCwd);
    expect(exported).not.toBeNull();
    expect(exported!.nodes.length).toBe(1);
    expect(exported!.exportedAt).toBeTruthy();
  });
});

describe('canvas actions', () => {
  it('resolveActionSafety classifies correctly', () => {
    expect(resolveActionSafety('open_node')).toBe('safe');
    expect(resolveActionSafety('export_canvas')).toBe('safe');
    expect(resolveActionSafety('attach_node_to_chat')).toBe('write');
    expect(resolveActionSafety('run_subagent_on_node')).toBe('dangerous');
    expect(resolveActionSafety('unknown_action')).toBe('write');
  });
});

describe('canvas audit', () => {
  beforeEach(() => clearCanvasAudit());

  it('writes and lists audit records', () => {
    writeCanvasAudit('canvas.workspace.created', { workspaceId: 'ws-1' });
    writeCanvasAudit('canvas.node.created', { workspaceId: 'ws-1', nodeId: 'n-1' });
    const list = listCanvasAudit();
    expect(list.length).toBe(2);
    expect(list[0].event).toBe('canvas.workspace.created');
  });

  it('lists recent events', () => {
    for (let i = 0; i < 5; i++) {
      writeCanvasAudit('canvas.node.created', { workspaceId: 'ws-1', nodeId: `n-${i}` });
    }
    expect(listCanvasAudit(3).length).toBe(3);
  });
});
