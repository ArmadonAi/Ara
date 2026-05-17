import { z } from 'zod';

export const DraftStatusSchema = z.enum(['draft', 'approved', 'rejected', 'superseded']);
export type DraftStatus = z.infer<typeof DraftStatusSchema>;

export interface SkillDraft {
  id: string;
  title: string;
  description: string;
  proposedSkillName: string;
  sourceSessionIds: string[];
  sourceTranscriptSeqs: number[];
  workflowFingerprint: string;
  confidence: number;
  status: DraftStatus;
  frontmatter: Record<string, unknown>;
  body: string;
  redactionWarnings: string[];
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  rejectedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface SkillVersion {
  skillName: string;
  version: number;
  draftId?: string;
  contentHash: string;
  changelog: string;
  createdAt: string;
  createdBy: 'user' | 'system';
  previousVersion?: number;
}

export interface WorkflowFingerprint {
  id: string;
  normalizedGoal: string;
  toolSequence: string[];
  filesTouchedPatterns: string[];
  skillNamesUsed: string[];
  memoryKeysUsed: string[];
  outcome: 'success' | 'partial' | 'failed';
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface SkillUsageStats {
  skillName: string;
  version: number;
  useCount: number;
  successCount: number;
  failureCount: number;
  lastUsedAt: string;
  avgDurationMs: number;
  feedbackScore?: number;
}

// Zod schemas for API
export const WorkflowAnalysisSchema = z.object({
  sessionIds: z.array(z.string()).optional(),
  threshold: z.number().int().min(1).optional().default(3),
});

export const DraftActionSchema = z.object({
  reason: z.string().optional(),
});
