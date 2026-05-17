const MAX_RECORDS = 1000;
const records: CanvasAuditRecord[] = [];

export interface CanvasAuditRecord {
  id: string;
  event: string;
  workspaceId: string;
  nodeId?: string;
  edgeId?: string;
  details?: string;
  timestamp: string;
}

export function writeCanvasAudit(event: string, data: {
  workspaceId: string; nodeId?: string; edgeId?: string; details?: string;
}): void {
  records.push({
    id: `canvas-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    event,
    workspaceId: data.workspaceId,
    nodeId: data.nodeId,
    edgeId: data.edgeId,
    details: data.details,
    timestamp: new Date().toISOString(),
  });
  if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
}

export function listCanvasAudit(limit: number = 100): CanvasAuditRecord[] {
  return records.slice(-limit);
}

export function clearCanvasAudit(): void {
  records.length = 0;
}
