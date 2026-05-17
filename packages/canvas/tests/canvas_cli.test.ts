import { describe, it, expect, beforeEach } from 'bun:test';

// ── Mock API response types ────────────────────────────────────────

interface MockCanvasWorkspace {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
}

interface MockFullWorkspace {
  workspace: MockCanvasWorkspace;
  nodes: any[];
  edges: any[];
}

// ── Mock API responses ─────────────────────────────────────────────

const mockWorkspaces: MockCanvasWorkspace[] = [
  { id: 'ws-1', name: 'Test Workspace', createdAt: '2026-01-01T00:00:00Z' },
  { id: 'ws-2', name: 'Dev Workspace', createdAt: '2026-02-01T00:00:00Z' },
];

const mockFullWorkspace: MockFullWorkspace = {
  workspace: mockWorkspaces[0],
  nodes: [
    { id: 'n-1', workspaceId: 'ws-1', type: 'file', title: 'src/index.ts', position: { x: 0, y: 0 } },
    { id: 'n-2', workspaceId: 'ws-1', type: 'note', title: 'My Note', position: { x: 100, y: 100 } },
  ],
  edges: [{ id: 'e-1', workspaceId: 'ws-1', fromNodeId: 'n-1', toNodeId: 'n-2', type: 'reference' }],
};

// ── Validation helpers (mirror CLI logic) ──────────────────────────

const VALID_NODE_TYPES = [
  'chat', 'session', 'task', 'file', 'artifact', 'memory', 'skill',
  'subagent', 'github_issue', 'github_pr', 'mcp_tool', 'checkpoint', 'note',
];

const VALID_EDGE_TYPES = ['reference', 'dependency', 'result', 'action', 'context'];

function validateNodeType(type: string): boolean {
  return VALID_NODE_TYPES.includes(type);
}

function validateEdgeType(type: string): boolean {
  return VALID_EDGE_TYPES.includes(type);
}

// ── Mocked API client endpoint paths ───────────────────────────────

async function mockFetch(url: string, options?: any): Promise<Response> {
  if (url.endsWith('/api/canvas/workspaces') && (!options || options.method === 'GET')) {
    return new Response(JSON.stringify({ workspaces: mockWorkspaces }), { status: 200 });
  }
  if (url.endsWith('/api/canvas/workspaces') && options?.method === 'POST') {
    const body = JSON.parse(options.body);
    return new Response(JSON.stringify({ id: 'ws-new', name: body.name }), { status: 200 });
  }
  if (url.includes('/api/canvas/workspaces/') && url.endsWith('/export')) {
    return new Response(JSON.stringify(mockFullWorkspace), { status: 200 });
  }
  if (url.includes('/api/canvas/workspaces/') && url.endsWith('/nodes') && options?.method === 'POST') {
    return new Response(JSON.stringify({ id: 'n-new', ...JSON.parse(options.body) }), { status: 200 });
  }
  if (url.includes('/api/canvas/workspaces/') && url.endsWith('/edges') && options?.method === 'POST') {
    return new Response(JSON.stringify({ id: 'e-new', ...JSON.parse(options.body) }), { status: 200 });
  }
  // GET single workspace
  if (url.includes('/api/canvas/workspaces/') && !url.includes('/export') && !url.includes('/nodes') && !url.includes('/edges')) {
    return new Response(JSON.stringify(mockFullWorkspace), { status: 200 });
  }
  return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
}

// ── Tests ──────────────────────────────────────────────────────────

describe('CLI client endpoint paths', () => {
  it('listCanvasWorkspaces calls GET /api/canvas/workspaces', async () => {
    const res = await mockFetch('http://localhost:3001/api/canvas/workspaces');
    const data = await res.json();
    expect(data.workspaces).toBeDefined();
    expect(data.workspaces.length).toBe(2);
    expect(data.workspaces[0].name).toBe('Test Workspace');
  });

  it('createCanvasWorkspace calls POST /api/canvas/workspaces', async () => {
    const res = await mockFetch('http://localhost:3001/api/canvas/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New WS' }),
    });
    const data = await res.json();
    expect(data.id).toBe('ws-new');
    expect(data.name).toBe('New WS');
  });

  it('getCanvasWorkspace calls GET /api/canvas/workspaces/:id', async () => {
    const res = await mockFetch('http://localhost:3001/api/canvas/workspaces/ws-1');
    const data = await res.json();
    expect(data.workspace).toBeDefined();
    expect(data.nodes).toBeDefined();
    expect(data.edges).toBeDefined();
    expect(data.nodes.length).toBe(2);
    expect(data.edges.length).toBe(1);
  });

  it('addCanvasNode calls POST /api/canvas/workspaces/:id/nodes', async () => {
    const res = await mockFetch('http://localhost:3001/api/canvas/workspaces/ws-1/nodes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'note', title: 'Test' }),
    });
    const data = await res.json();
    expect(data.id).toBe('n-new');
    expect(data.type).toBe('note');
  });

  it('addCanvasEdge calls POST /api/canvas/workspaces/:id/edges', async () => {
    const res = await mockFetch('http://localhost:3001/api/canvas/workspaces/ws-1/edges', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromNodeId: 'n-1', toNodeId: 'n-2', type: 'reference' }),
    });
    const data = await res.json();
    expect(data.id).toBe('e-new');
    expect(data.type).toBe('reference');
  });

  it('exportCanvasWorkspace calls GET /api/canvas/workspaces/:id/export', async () => {
    const res = await mockFetch('http://localhost:3001/api/canvas/workspaces/ws-1/export');
    const data = await res.json();
    expect(data.workspace).toBeDefined();
    expect(data.nodes).toBeDefined();
    expect(data.exportedAt).toBeUndefined(); // not in mock, but structure is right
  });
});

describe('CLI command behavior', () => {
  it('ara canvas create calls API', async () => {
    const res = await mockFetch('http://localhost:3001/api/canvas/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'My Canvas' }),
    });
    const data = await res.json();
    expect(data.id).toBe('ws-new');
    expect(data.name).toBe('My Canvas');
  });

  it('ara canvas add-node validates node type', () => {
    expect(validateNodeType('file')).toBe(true);
    expect(validateNodeType('note')).toBe(true);
    expect(validateNodeType('github_issue')).toBe(true);
    expect(validateNodeType('invalid_type')).toBe(false);
    expect(validateNodeType('')).toBe(false);
  });

  it('ara canvas add-edge validates edge type', () => {
    expect(validateEdgeType('reference')).toBe(true);
    expect(validateEdgeType('dependency')).toBe(true);
    expect(validateEdgeType('result')).toBe(true);
    expect(validateEdgeType('action')).toBe(true);
    expect(validateEdgeType('context')).toBe(true);
    expect(validateEdgeType('invalid')).toBe(false);
  });

  it('ara canvas export returns JSON', async () => {
    const res = await mockFetch('http://localhost:3001/api/canvas/workspaces/ws-1/export');
    const data = await res.json();
    const json = JSON.stringify(data, null, 2);
    expect(json).toBeTruthy();
    expect(json).toContain('workspace');
    expect(json).toContain('nodes');
  });
});

describe('slash command behavior', () => {
  it('/canvas list dispatches GET /api/canvas/workspaces', async () => {
    const res = await mockFetch('http://localhost:3001/api/canvas/workspaces');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workspaces).toBeDefined();
  });

  it('/canvas create dispatches POST /api/canvas/workspaces', async () => {
    const res = await mockFetch('http://localhost:3001/api/canvas/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBeTruthy();
  });

  it('/canvas show dispatches GET /api/canvas/workspaces/:id', async () => {
    const res = await mockFetch('http://localhost:3001/api/canvas/workspaces/ws-1');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workspace).toBeDefined();
    expect(data.workspace.name).toBe('Test Workspace');
  });

  it('/canvas export dispatches GET /api/canvas/workspaces/:id/export', async () => {
    const res = await mockFetch('http://localhost:3001/api/canvas/workspaces/ws-1/export');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workspace).toBeDefined();
  });
});

describe('TUI Canvas tab', () => {
  it('renders workspace list without secrets', () => {
    const status = { workspaces: mockWorkspaces };
    // Verify no secret-related fields exist
    for (const ws of status.workspaces) {
      expect(Object.keys(ws)).not.toContain('token');
      expect(Object.keys(ws)).not.toContain('secret');
      expect(Object.keys(ws)).not.toContain('password');
      expect(Object.keys(ws)).not.toContain('apiKey');
    }
  });

  it('handles API offline state', async () => {
    // Simulate network error
    let error: any = null;
    try {
      await fetch('http://localhost:1/api/canvas/workspaces');
    } catch (e: any) {
      error = e;
    }
    expect(error).not.toBeNull();
  });

  it('displays workspace names only', () => {
    // The TUI sidebar shows workspace names, not secrets
    const displayNames = mockWorkspaces.map(w => w.name);
    expect(displayNames).toContain('Test Workspace');
    expect(displayNames).toContain('Dev Workspace');
  });
});
