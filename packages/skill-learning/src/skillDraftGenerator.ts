import type { SkillDraft, WorkflowFingerprint } from './types';
import { writeSkillLearningAudit } from './skillLearningAudit';
import { saveDraft } from './skillDraftStore';

let counter = 0;
function genId(): string {
  counter++;
  return `draft-${Date.now()}-${counter}`;
}

/**
 * Redact potential secrets from a string.
 */
function redactSecrets(text: string): { cleaned: string; warnings: string[] } {
  const warnings: string[] = [];
  let cleaned = text;

  const patterns: [RegExp, string, string][] = [
    [/sk-[a-zA-Z0-9]{32,}/g, 'sk-***', 'OpenAI API key'],
    [/sk-ant-[a-zA-Z0-9_-]{20,}/g, 'sk-ant-***', 'Anthropic API key'],
    [/AIza[0-9A-Za-z-_]{35}/g, 'AIza***', 'Google API key'],
    [/ghp_[a-zA-Z0-9]{36,}/g, 'ghp_***', 'GitHub PAT'],
    [/github_pat_[a-zA-Z0-9_-]{30,}/g, 'github_pat_***', 'GitHub fine-grained PAT'],
    [/glpat-[a-zA-Z0-9\-_]{20,}/g, 'glpat-***', 'GitLab PAT'],
  ];

  for (const [regex, replacement, label] of patterns) {
    if (regex.test(cleaned)) {
      warnings.push(`Redacted ${label}`);
      cleaned = cleaned.replace(regex, replacement);
    }
  }

  return { cleaned, warnings };
}

/**
 * Generate a skill draft from a workflow fingerprint.
 */
export async function generateDraft(
  fingerprint: WorkflowFingerprint,
  cwd: string = process.cwd(),
): Promise<SkillDraft> {
  const goal = fingerprint.normalizedGoal;
  const safeName = goal
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40) || 'learned_skill';

  const title = fingerprint.normalizedGoal
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
    .slice(0, 80);

  // Build SKILL.md-style body
  const procedureSteps = fingerprint.toolSequence
    .map((tool, i) => `${i + 1}. Use \`${tool}\` tool`)
    .join('\n');

  const body = `## When to use
${title}

## Inputs
- Goal: ${fingerprint.normalizedGoal}

## Procedure
${procedureSteps || '1. Execute the standard workflow for this task.'}

## Tools
${fingerprint.toolSequence.map(t => `- \`${t}\``).join('\n') || '- Standard Ara tools'}

## Output
- Summary of actions taken
- Results from each step

## Verification
- Confirm expected outcome matches result
`;

  const frontmatter: Record<string, unknown> = {
    name: safeName,
    description: title.slice(0, 120),
    tags: fingerprint.toolSequence.slice(0, 5),
    version: 1,
    source: 'skill-learning',
  };

  const confidence = Math.min(fingerprint.count / 10, 1);

  const draft: SkillDraft = {
    id: genId(),
    title,
    description: `Learned from ${fingerprint.count} repetitions of: ${fingerprint.normalizedGoal}`,
    proposedSkillName: safeName,
    sourceSessionIds: [],
    sourceTranscriptSeqs: [],
    workflowFingerprint: fingerprint.id,
    confidence,
    status: 'draft',
    frontmatter,
    body,
    redactionWarnings: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {
      toolCount: fingerprint.toolSequence.length,
      repeatCount: fingerprint.count,
      firstSeen: fingerprint.firstSeenAt,
    },
  };

  // Redact secrets from body
  const { cleaned, warnings } = redactSecrets(draft.body);
  draft.body = cleaned;
  draft.redactionWarnings = warnings;

  await saveDraft(draft, cwd);

  writeSkillLearningAudit('skill_learning.draft_created', {
    draftId: draft.id,
    details: `name=${safeName} confidence=${confidence}`,
  });

  return draft;
}
