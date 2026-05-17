export interface AuditEvent {
  id: string;
  sessionId: string;
  eventType: string;
  toolName?: string;
  input?: any;
  outputSummary?: string;
  status: 'success' | 'failed';
  createdAt: Date;
}

export function logSubagentAudit(
  sessionId: string,
  eventType: string,
  details: {
    runId?: string;
    toolName?: string;
    input?: any;
    outputSummary?: string;
    status: 'success' | 'failed';
  }
): AuditEvent {
  return {
    id: Math.random().toString(36).substring(7),
    sessionId,
    eventType,
    toolName: details.toolName,
    input: details.input,
    outputSummary: details.outputSummary || `Subagent event: ${eventType}`,
    status: details.status,
    createdAt: new Date()
  };
}
