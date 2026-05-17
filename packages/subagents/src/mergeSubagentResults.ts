import type { SubagentResult } from './types';

export function mergeSubagentResults(results: SubagentResult[]): SubagentResult {
  if (results.length === 0) {
    return {
      summary: 'No subagent results to merge.',
      findings: [],
      artifacts: [],
      nextActions: []
    };
  }

  const summaries: string[] = [];
  const findings = new Set<string>();
  const artifacts = new Set<string>();
  const nextActions = new Set<string>();

  for (const r of results) {
    summaries.push(r.summary);
    r.findings.forEach(f => findings.add(f));
    r.artifacts.forEach(a => artifacts.add(a));
    r.nextActions.forEach(n => nextActions.add(n));
  }

  return {
    summary: summaries.join(' | '),
    findings: Array.from(findings),
    artifacts: Array.from(artifacts),
    nextActions: Array.from(nextActions)
  };
}

export function formatSubagentResultMarkdown(result: SubagentResult, profileName: string): string {
  return `### 🤖 Subagent [${profileName}] Output Results

#### 📝 Summary
${result.summary}

#### 🔍 Findings
${result.findings.map(f => `- ${f}`).join('\n') || '*No explicit findings reported.*'}

#### 📦 Artifacts
${result.artifacts.map(a => `- ${a}`).join('\n') || '*No artifacts created.*'}

#### 🚀 Recommended Next Actions
${result.nextActions.map(n => `- ${n}`).join('\n') || '*No next actions suggested.*'}`;
}
