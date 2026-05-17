import type { CanvasWorkspace, CanvasNode, CanvasEdge, CanvasExport } from './types';
import { getFullWorkspace } from './canvasStore';

export async function exportCanvas(
  workspaceId: string, cwd: string = process.cwd(),
): Promise<CanvasExport | null> {
  const data = await getFullWorkspace(workspaceId, cwd);
  if (!data.workspace) return null;
  return {
    workspace: data.workspace,
    nodes: data.nodes,
    edges: data.edges,
    exportedAt: new Date().toISOString(),
  };
}
