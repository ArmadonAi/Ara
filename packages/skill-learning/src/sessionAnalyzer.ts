import { updateWorkflowFingerprint, findRepeatedWorkflows } from './workflowDetector';
import { generateDraft } from './skillDraftGenerator';
import { extractToolSequence, extractGoal } from './sessionToProcedure';
import type { SessionTranscriptEntry } from './sessionToProcedure';

/**
 * Analyze a single session transcript and update workflow fingerprints.
 * Returns the fingerprint and any generated draft.
 */
export async function analyzeSession(
  sessionId: string,
  entries: SessionTranscriptEntry[],
  cwd: string = process.cwd(),
): Promise<{
  fingerprint: any;
  draft: any | null;
  threshold: number;
  met: boolean;
}> {
  const goal = extractGoal(entries) || 'Unnamed session';
  const toolSequence = extractToolSequence(entries);

  const fp = updateWorkflowFingerprint({ goal, toolSequence, outcome: 'success' });

  let draft = null;
  if (fp.count >= 3) {
    draft = await generateDraft(fp, cwd);
  }

  return { fingerprint: fp, draft, threshold: 3, met: fp.count >= 3 };
}

/**
 * Analyze multiple recent sessions.
 */
export async function analyzeRecentSessions(
  sessions: { sessionId: string; entries: SessionTranscriptEntry[] }[],
  cwd: string = process.cwd(),
): Promise<{
  analyzed: number;
  fingerprints: any[];
  drafts: any[];
}> {
  const drafts: any[] = [];

  for (const session of sessions) {
    const result = await analyzeSession(session.sessionId, session.entries, cwd);
    if (result.draft) drafts.push(result.draft);
  }

  const fingerprints = findRepeatedWorkflows(3);
  return { analyzed: sessions.length, fingerprints, drafts };
}
