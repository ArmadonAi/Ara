import * as fs from 'fs/promises';
import * as path from 'path';
import yaml from 'js-yaml';
import { SubagentProfileSchema } from './schema';
import type { SubagentProfile } from './types';
import type { ToolRegistry } from '@ara/tools';

const BUILTIN_PROFILES: Record<string, string> = {
  'researcher.md': `---
name: researcher
description: Perform read-only file research and codebase structure exploration.
model: default
permissionMode: plan
maxTurns: 8
tools:
  - list_files
  - read_file
tags:
  - research
  - analysis
---
You are an expert research subagent. Explore the codebase structure and read files to answer the user's questions. Focus on identifying key relationships and compiling detailed factual reports.`,

  'code-reviewer.md': `---
name: code-reviewer
description: Review code for bugs, security, and maintainability.
model: default
permissionMode: plan
maxTurns: 8
tools:
  - list_files
  - read_file
  - git_status
  - git_diff
tags:
  - coding
  - review
---
You are a senior code reviewer. Analyze the files, recent diffs, and codebase structure. Identify potential bugs, anti-patterns, maintainability issues, and provide structured improvement feedback.`,

  'debugger.md': `---
name: debugger
description: Inspect local state, recent changes, and code files to identify roots of bugs.
model: default
permissionMode: plan
maxTurns: 8
tools:
  - list_files
  - read_file
  - git_status
  - git_diff
tags:
  - debug
  - troubleshoot
---
You are an expert debugging assistant. Help diagnose issues by checking git status, diffs, and codebase file contents. Trace error origins and isolate variables step-by-step.`,

  'security-reviewer.md': `---
name: security-reviewer
description: Analyze files and diffs for secrets, logic flaws, or vulnerability vectors.
model: default
permissionMode: plan
maxTurns: 8
tools:
  - list_files
  - read_file
  - git_status
  - git_diff
tags:
  - security
  - audit
---
You are a certified security auditor. Scan files and diffs to identify exposed credentials, access control flaws, logic vulnerabilities, and general security posture improvements.`
};

export async function ensureBuiltinProfiles(agentsDir: string) {
  await fs.mkdir(agentsDir, { recursive: true });
  for (const [filename, content] of Object.entries(BUILTIN_PROFILES)) {
    const destPath = path.join(agentsDir, filename);
    const exists = await fs.stat(destPath).then(() => true).catch(() => false);
    if (!exists) {
      await fs.writeFile(destPath, content, 'utf-8');
    }
  }
}

export async function loadAgentProfileFile(filePath: string, registry?: ToolRegistry): Promise<SubagentProfile> {
  const content = await fs.readFile(filePath, 'utf-8');
  const parts = content.split('---');
  if (parts.length < 3) {
    throw new Error(`Profile ${path.basename(filePath)} lacks frontmatter block delimiters '---'`);
  }
  const frontmatterRaw = parts[1] || '';
  const systemPrompt = parts.slice(2).join('---').trim();

  const data = yaml.load(frontmatterRaw) as any;
  if (!data || typeof data !== 'object') {
    throw new Error(`Invalid frontmatter YAML in profile ${path.basename(filePath)}`);
  }

  // Set system prompt if not present in yaml
  if (!data.systemPrompt) {
    data.systemPrompt = systemPrompt;
  }

  // Validate via Zod
  const parsed = SubagentProfileSchema.parse(data);

  // Validate tools
  if (registry) {
    const registeredNames = new Set(registry.list().map(t => t.name));
    for (const toolName of parsed.tools) {
      if (!registeredNames.has(toolName)) {
        throw new Error(`Profile specifies unknown tool: "${toolName}" which is not available in registry.`);
      }
      
      const dangerousTools = ['write_file', 'edit_file', 'run_shell'];
      if (parsed.permissionMode === 'plan' && dangerousTools.includes(toolName)) {
        throw new Error(`Profile specifies dangerous tool "${toolName}" but uses plan mode which is read-only.`);
      }
    }
  }

  return {
    ...parsed,
    systemPrompt: parsed.systemPrompt || systemPrompt
  } as SubagentProfile;
}

export async function loadAgentProfiles(agentsDir: string, registry?: ToolRegistry): Promise<SubagentProfile[]> {
  await ensureBuiltinProfiles(agentsDir);
  const files = await fs.readdir(agentsDir);
  const profiles: SubagentProfile[] = [];
  
  for (const file of files) {
    if (file.endsWith('.md')) {
      try {
        const prof = await loadAgentProfileFile(path.join(agentsDir, file), registry);
        profiles.push(prof);
      } catch (err) {
        // Skip or bubble up? Bubble up to meet strict validation rejection.
        throw err;
      }
    }
  }
  
  return profiles;
}
