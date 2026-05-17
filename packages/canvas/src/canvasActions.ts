import type { CanvasNode } from './types';
import { getAllNodes, updateNode } from './canvasStore';
import { writeCanvasAudit } from './canvasAudit';

/**
 * Dispatch a canvas action. Actions that read can run directly.
 * Actions that write/mutate must be dispatched through the API/runtime
 * which enforces Permission Engine + Approval Gate + Locks.
 */
export function resolveActionSafety(action: string): 'safe' | 'write' | 'dangerous' {
  const readActions = ['open_node', 'summarize_node', 'export_canvas', 'inspect_mcp_tool_node'];
  const writeActions = [
    'attach_node_to_chat', 'create_task_from_node', 'link_nodes',
    'create_memory_from_node', 'create_skill_from_node',
  ];
  const dangerousActions = ['run_subagent_on_node', 'review_github_pr_node'];
  if (readActions.includes(action)) return 'safe';
  if (writeActions.includes(action)) return 'write';
  if (dangerousActions.includes(action)) return 'dangerous';
  return 'write'; // default to write
}

export async function executeSafeAction(
  workspaceId: string, nodeId: string, action: string,
  _params: Record<string, unknown>,
  cwd: string = process.cwd(),
): Promise<{ ok: boolean; result?: string; error?: string }> {
  const allNodes = await getAllNodes(workspaceId, cwd);
  const node = allNodes.find(n => n.id === nodeId);
  if (!node) return { ok: false, error: `Node "${nodeId}" not found` };

  writeCanvasAudit('canvas.action.executed', {
    workspaceId, nodeId, details: `action=${action}`,
  });

  switch (action) {
    case 'open_node':
      return { ok: true, result: JSON.stringify(node, null, 2) };
    case 'summarize_node':
      return { ok: true, result: `${node.type}: ${node.title}${node.description ? ` — ${node.description}` : ''}` };
    case 'export_canvas':
      return { ok: true, result: `Canvas can be exported via /api/canvas/${workspaceId}/export` };
    case 'inspect_mcp_tool_node':
      return { ok: true, result: JSON.stringify(node.data, null, 2) };
    default:
      return { ok: false, error: `Action "${action}" requires API dispatch for safety enforcement` };
  }
}
