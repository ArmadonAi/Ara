import type { CanvasEdge, EdgeType } from './types';

let counter = 0;
function genId(): string {
  counter++;
  return `edge-${Date.now()}-${counter}`;
}

export function createEdge(
  workspaceId: string, fromNodeId: string, toNodeId: string,
  type: EdgeType = 'reference', label?: string,
): CanvasEdge {
  return {
    id: genId(),
    workspaceId,
    fromNodeId,
    toNodeId,
    type,
    label,
    createdAt: new Date().toISOString(),
  };
}
