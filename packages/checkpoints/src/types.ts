export interface CheckpointFileSnapshot {
  path: string;
  absolutePath: string;
  existsBefore: boolean;
  contentHashBefore?: string;
  contentBefore?: string;
  sizeBytes: number;
  isBinary: boolean;
  isLarge: boolean;
  skipped: boolean;
  skipReason?: string;
}

export interface SessionSnapshot {
  sessionId: string;
  messageIds: string[];
  messageCount: number;
  activeModel: string;
  permissionMode: string;
  compactDigest?: string;
  transcriptSeq: number;
  pendingApprovalIds: string[];
  createdAt: string;
}

export interface Checkpoint {
  id: string;
  sessionId: string;
  cwd: string;
  reason: string;
  createdAt: string;
  createdBy: 'agent' | 'user' | 'hook' | 'system';
  beforeToolName?: string;
  beforeToolInput?: string;
  transcriptSeq: number;
  messageCount: number;
  gitHead?: string;
  files: CheckpointFileSnapshot[];
  sessionSnapshot: SessionSnapshot;
  metadata?: Record<string, any>;
}

export type CheckpointRestoreMode = 'code_only' | 'conversation_only' | 'both';

export interface CheckpointRestoreResult {
  checkpointId: string;
  mode: CheckpointRestoreMode;
  filesRestored: string[];
  messagesRestored: number;
  transcriptSeqRestored: number;
  warnings: string[];
  errors: string[];
  restoredAt: string;
}

export interface CheckpointDiffResult {
  checkpointId: string;
  filesChangedSince: string[];
  filesCreatedSince: string[];
  filesDeletedSince: string[];
  filesSkipped: string[];
  warnings: string[];
  messageCountDiff: number;
  transcriptSeqDiff: number;
}
