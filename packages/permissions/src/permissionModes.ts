import type { PermissionMode, PermissionDecision } from './types';

export const SAFE_READ_TOOLS = new Set([
  'list_files',
  'read_file',
  'git_status',
  'git_diff',
  'list_skills',
  'list_memories',
  'search_memory',
  'load_skill',
]);

export const WRITE_EDIT_TOOLS = new Set([
  'write_file',
  'edit_file',
]);

export const SHELL_TOOLS = new Set([
  'run_shell',
]);

export function evaluateModeBaseline(
  mode: PermissionMode,
  toolName: string,
  command?: string
): PermissionDecision {
  const isRead = SAFE_READ_TOOLS.has(toolName);
  const isWrite = WRITE_EDIT_TOOLS.has(toolName);
  const isShell = SHELL_TOOLS.has(toolName);

  switch (mode) {
    case 'plan':
      if (isRead) return 'allow';
      return 'deny';

    case 'default':
      if (isRead) return 'allow';
      return 'ask';

    case 'accept-edits':
      if (isRead || isWrite) return 'allow';
      return 'ask';

    case 'auto-safe':
      // Allow known safe commands and reads
      if (isRead) return 'allow';
      if (isShell && command) {
        const cleanCmd = command.trim().toLowerCase();
        const safeCommands = [
          'git status',
          'git diff',
          'git log',
          'bun run typecheck',
          'bun test',
          'npm run typecheck',
          'npm test',
          'pwd',
          'ls',
          'dir',
        ];
        if (safeCommands.some(sc => cleanCmd === sc || cleanCmd.startsWith(sc + ' '))) {
          return 'allow';
        }
      }
      return 'ask';

    case 'danger-review':
      // Ask everything (including safe reads) except what is explicitly denied by defaults
      return 'ask';

    default:
      return 'ask';
  }
}
