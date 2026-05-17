/**
 * Extract tool sequences from a session transcript.
 * In v0.1, this is a helper that parses tool call patterns.
 * Future versions can analyze session transcripts in depth.
 */

export interface SessionTranscriptEntry {
  role: string;
  content: string;
  toolCalls?: { name: string; input?: string }[];
  timestamp?: string;
}

/**
 * Extract tool call names from session transcript entries.
 */
export function extractToolSequence(entries: SessionTranscriptEntry[]): string[] {
  const tools: string[] = [];
  for (const entry of entries) {
    if (entry.toolCalls) {
      for (const tc of entry.toolCalls) {
        if (!tools.includes(tc.name)) tools.push(tc.name);
      }
    }
    // Also parse tool calls from content XML
    if (entry.content) {
      const matches = entry.content.match(/<tool_call\s+name="([^"]+)"/g);
      if (matches) {
        for (const m of matches) {
          const name = m.replace(/<tool_call\s+name="/, '').replace('"', '');
          if (!tools.includes(name)) tools.push(name);
        }
      }
    }
  }
  return tools;
}

/**
 * Extract the main goal from a session transcript (first user message).
 */
export function extractGoal(entries: SessionTranscriptEntry[]): string {
  for (const entry of entries) {
    if (entry.role === 'user' && entry.content) {
      return entry.content.slice(0, 500);
    }
  }
  return '';
}
