import { useState, useEffect, useCallback } from 'react';

interface Workspace {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
}

interface CanvasNode {
  id: string;
  type: string;
  title: string;
  description?: string;
  sourceRef?: string;
}

interface FullWorkspace {
  workspace: Workspace;
  nodes: CanvasNode[];
  edges: any[];
  description?: string;
}

const API = 'http://localhost:3001';

export function CanvasPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWs, setSelectedWs] = useState<FullWorkspace | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [selectedNode, setSelectedNode] = useState<CanvasNode | null>(null);

  const loadWorkspaces = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/canvas/workspaces`);
      const data = await res.json();
      setWorkspaces(data.workspaces || []);
    } catch {}
  }, []);

  useEffect(() => { loadWorkspaces(); }, [loadWorkspaces]);

  const createWorkspace = async () => {
    if (!newName.trim()) return;
    try {
      await fetch(`${API}/api/canvas/workspaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      });
      setNewName('');
      setShowCreate(false);
      loadWorkspaces();
    } catch {}
  };

  const loadWorkspace = async (id: string) => {
    try {
      const res = await fetch(`${API}/api/canvas/workspaces/${id}`);
      const data = await res.json();
      setSelectedWs(data);
      setSelectedNode(null);
    } catch {}
  };

  const deleteWs = async (id: string) => {
    try {
      await fetch(`${API}/api/canvas/workspaces/${id}`, { method: 'DELETE' });
      if (selectedWs?.workspace.id === id) setSelectedWs(null);
      loadWorkspaces();
    } catch {}
  };

  const nodeColors: Record<string, string> = {
    chat: '#4FC3F7', file: '#81C784', memory: '#FFB74D', skill: '#CE93D8',
    github_issue: '#82B1FF', github_pr: '#82B1FF', mcp_tool: '#F48FB1',
    subagent: '#4DB6AC', checkpoint: '#FF8A65', note: '#E0E0E0', task: '#FFF176',
  };

  return (
    <div style={{ padding: '20px', fontFamily: 'system-ui, sans-serif', maxWidth: 1200, margin: '0 auto' }}>
      <h1>Canvas Workspaces</h1>

      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
        {/* Sidebar */}
        <div style={{ width: 280, flexShrink: 0 }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <button onClick={() => setShowCreate(!showCreate)}
              style={{ padding: '8px 16px', background: '#1976D2', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
              + New Workspace
            </button>
          </div>
          {showCreate && (
            <div style={{ marginBottom: 12, display: 'flex', gap: 4 }}>
              <input value={newName} onChange={e => setNewName(e.target.value)}
                placeholder="Workspace name" style={{ flex: 1, padding: 6, border: '1px solid #ccc', borderRadius: 4 }} />
              <button onClick={createWorkspace}
                style={{ padding: '6px 12px', background: '#388E3C', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
                Create
              </button>
            </div>
          )}
          <div style={{ border: '1px solid #e0e0e0', borderRadius: 8, overflow: 'hidden' }}>
            {workspaces.map(ws => (
              <div key={ws.id}
                onClick={() => loadWorkspace(ws.id)}
                style={{
                  padding: '10px 14px', cursor: 'pointer', borderBottom: '1px solid #f0f0f0',
                  background: selectedWs?.workspace.id === ws.id ? '#E3F2FD' : 'white',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{ws.name}</div>
                  <div style={{ fontSize: 12, color: '#888' }}>{ws.createdAt?.slice(0, 10)}</div>
                </div>
                <button onClick={e => { e.stopPropagation(); deleteWs(ws.id); }}
                  style={{ background: 'none', border: 'none', color: '#e53935', cursor: 'pointer', fontSize: 16 }}>×</button>
              </div>
            ))}
            {workspaces.length === 0 && (
              <div style={{ padding: 20, color: '#888', textAlign: 'center' }}>No workspaces yet</div>
            )}
          </div>
        </div>

        {/* Canvas board */}
        <div style={{ flex: 1, minHeight: 500, border: '1px solid #e0e0e0', borderRadius: 8, padding: 16 }}>
          {!selectedWs ? (
            <div style={{ color: '#888', textAlign: 'center', paddingTop: 100 }}>Select a workspace from the sidebar</div>
          ) : (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <h2 style={{ margin: 0 }}>{selectedWs.workspace.name}</h2>
                <a href={`${API}/api/canvas/workspaces/${selectedWs.workspace.id}/export`} target="_blank" rel="noreferrer"
                  style={{ padding: '6px 14px', background: '#546E7A', color: 'white', textDecoration: 'none', borderRadius: 4, fontSize: 14 }}>
                  Export JSON
                </a>
              </div>

              {selectedWs.description && <p style={{ color: '#666', marginTop: -8 }}>{selectedWs.description}</p>}

              {/* Stats */}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
                {Object.entries(
                  selectedWs.nodes.reduce((acc: Record<string, number>, n) => {
                    acc[n.type] = (acc[n.type] || 0) + 1;
                    return acc;
                  }, {})
                ).map(([type, count]) => (
                  <span key={type} style={{
                    padding: '4px 10px', borderRadius: 12, fontSize: 13,
                    background: nodeColors[type] || '#e0e0e0', color: '#333',
                  }}>
                    {type}: {count}
                  </span>
                ))}
                {selectedWs.nodes.length === 0 && <span style={{ color: '#888' }}>No nodes in this workspace</span>}
              </div>

              {/* Nodes grid */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                {selectedWs.nodes.map(node => (
                  <div key={node.id}
                    onClick={() => setSelectedNode(node)}
                    style={{
                      padding: '10px 14px', borderRadius: 8, cursor: 'pointer', width: 200,
                      borderLeft: `4px solid ${nodeColors[node.type] || '#e0e0e0'}`,
                      background: selectedNode?.id === node.id ? '#E3F2FD' : '#fafafa',
                      boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
                    }}>
                    <div style={{ fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 1 }}>{node.type}</div>
                    <div style={{ fontWeight: 600, fontSize: 14, margin: '4px 0' }}>{node.title}</div>
                    {node.description && <div style={{ fontSize: 12, color: '#666' }}>{node.description}</div>}
                    {node.sourceRef && <div style={{ fontSize: 11, color: '#aaa', marginTop: 4 }}>{node.sourceRef}</div>}
                  </div>
                ))}
              </div>

              {/* Node detail panel */}
              {selectedNode && (
                <div style={{ marginTop: 20, padding: 16, background: '#f5f5f5', borderRadius: 8 }}>
                  <h3 style={{ margin: '0 0 8px 0' }}>{selectedNode.title}</h3>
                  <table style={{ fontSize: 13, width: '100%' }}>
                    <tbody>
                      <tr><td style={{ padding: '4px 8px', fontWeight: 600, color: '#555', width: 100 }}>Type</td>
                        <td>{selectedNode.type}</td></tr>
                      <tr><td style={{ padding: '4px 8px', fontWeight: 600, color: '#555' }}>ID</td>
                        <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{selectedNode.id}</td></tr>
                      {selectedNode.description && (
                        <tr><td style={{ padding: '4px 8px', fontWeight: 600, color: '#555' }}>Description</td>
                          <td>{selectedNode.description}</td></tr>
                      )}
                      {selectedNode.sourceRef && (
                        <tr><td style={{ padding: '4px 8px', fontWeight: 600, color: '#555' }}>Source</td>
                          <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{selectedNode.sourceRef}</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
