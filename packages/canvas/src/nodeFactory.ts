import type { CanvasNode, NodeType, CanvasPosition } from './types';

let counter = 0;
function genId(): string {
  counter++;
  return `node-${Date.now()}-${counter}`;
}

function baseNode(
  workspaceId: string, type: NodeType, title: string,
  pos?: CanvasPosition, sourceRef?: string, description?: string,
): CanvasNode {
  return {
    id: genId(),
    workspaceId,
    type,
    title,
    description,
    position: pos || { x: 0, y: 0 },
    data: {},
    sourceRef,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function createChatNode(workspaceId: string, sessionId: string, title: string): CanvasNode {
  return { ...baseNode(workspaceId, 'chat', title, undefined, `session:${sessionId}`), data: { sessionId } };
}

export function createFileNode(workspaceId: string, filePath: string): CanvasNode {
  const name = filePath.split('/').pop() || filePath;
  return { ...baseNode(workspaceId, 'file', name, undefined, `file:${filePath}`), data: { filePath }, description: filePath };
}

export function createArtifactNode(workspaceId: string, artifactId: string, title: string): CanvasNode {
  return { ...baseNode(workspaceId, 'artifact', title, undefined, `artifact:${artifactId}`), data: { artifactId } };
}

export function createMemoryNode(workspaceId: string, memoryId: string, title: string): CanvasNode {
  return { ...baseNode(workspaceId, 'memory', title, undefined, `memory:${memoryId}`), data: { memoryId } };
}

export function createSkillNode(workspaceId: string, skillName: string): CanvasNode {
  return { ...baseNode(workspaceId, 'skill', skillName, undefined, `skill:${skillName}`), data: { skillName } };
}

export function createSubagentNode(workspaceId: string, runId: string, profileName: string): CanvasNode {
  return {
    ...baseNode(workspaceId, 'subagent', `Subagent: ${profileName}`, undefined, `subagent_run:${runId}`),
    data: { runId, profileName },
  };
}

export function createGitHubIssueNode(workspaceId: string, owner: string, repo: string, issueNumber: number, title: string): CanvasNode {
  return {
    ...baseNode(workspaceId, 'github_issue', `#${issueNumber}: ${title.slice(0, 60)}`, undefined, `github_issue:${owner}/${repo}#${issueNumber}`),
    data: { owner, repo, issueNumber },
  };
}

export function createGitHubPRNode(workspaceId: string, owner: string, repo: string, pullNumber: number, title: string): CanvasNode {
  return {
    ...baseNode(workspaceId, 'github_pr', `PR #${pullNumber}: ${title.slice(0, 60)}`, undefined, `github_pr:${owner}/${repo}#${pullNumber}`),
    data: { owner, repo, pullNumber },
  };
}

export function createMcpToolNode(workspaceId: string, fullToolName: string, serverId: string, toolName: string): CanvasNode {
  return {
    ...baseNode(workspaceId, 'mcp_tool', fullToolName, undefined, `mcp_tool:${fullToolName}`),
    data: { fullToolName, serverId, toolName },
  };
}

export function createCheckpointNode(workspaceId: string, checkpointId: string, reason: string): CanvasNode {
  return {
    ...baseNode(workspaceId, 'checkpoint', reason.slice(0, 80), undefined, `checkpoint:${checkpointId}`),
    data: { checkpointId, reason },
  };
}

export function createNoteNode(workspaceId: string, title: string, content: string): CanvasNode {
  return { ...baseNode(workspaceId, 'note', title), data: { content } };
}
