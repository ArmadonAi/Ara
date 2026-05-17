const MAX_RECORDS = 1000;
const records: SkillLearningAuditRecord[] = [];

export interface SkillLearningAuditRecord {
  id: string;
  event: string;
  details?: string;
  draftId?: string;
  skillName?: string;
  timestamp: string;
}

export function writeSkillLearningAudit(event: string, data: {
  details?: string; draftId?: string; skillName?: string;
}): void {
  records.push({
    id: `sl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    event,
    details: data.details,
    draftId: data.draftId,
    skillName: data.skillName,
    timestamp: new Date().toISOString(),
  });
  if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
}

export function listSkillLearningAudit(limit: number = 100): SkillLearningAuditRecord[] {
  return records.slice(-limit);
}

export function clearSkillLearningAudit(): void {
  records.length = 0;
}
