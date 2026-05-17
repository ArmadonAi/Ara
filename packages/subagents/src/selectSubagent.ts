import type { SubagentProfile } from './types';

export function selectSubagent(profiles: SubagentProfile[], name: string): SubagentProfile | undefined {
  return profiles.find(p => p.name === name);
}
