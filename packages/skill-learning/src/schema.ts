import { z } from 'zod';
import { DraftStatusSchema } from './types';

export const SkillDraftSchema = z.object({
  title: z.string().min(1),
  description: z.string(),
  proposedSkillName: z.string().min(1),
  sourceSessionIds: z.array(z.string()),
  sourceTranscriptSeqs: z.array(z.number()),
  workflowFingerprint: z.string(),
  confidence: z.number().min(0).max(1),
  frontmatter: z.record(z.unknown()),
  body: z.string(),
  redactionWarnings: z.array(z.string()),
  metadata: z.record(z.unknown()).optional(),
});

export const ApproveDraftSchema = z.object({
  reason: z.string().optional(),
});

export const RejectDraftSchema = z.object({
  reason: z.string().optional(),
});
