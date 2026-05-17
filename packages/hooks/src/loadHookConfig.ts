import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SettingsSchema } from './schema';
import type { HooksMapSchema } from './schema';
import type { z } from 'zod';

export type HooksMap = z.infer<typeof HooksMapSchema>;

export function getSettingsPaths(cwd: string = process.cwd()): string[] {
  const homePath = path.join(os.homedir(), '.ara', 'settings.json');
  const localPath = path.join(cwd, '.ara', 'settings.json');
  return [localPath, homePath];
}

export function loadHookConfig(cwd: string = process.cwd()): { hooks: HooksMap; diagnostics?: string } {
  const paths = getSettingsPaths(cwd);
  let loadedContent = '';
  let selectedPath = '';

  for (const p of paths) {
    if (fs.existsSync(p)) {
      try {
        loadedContent = fs.readFileSync(p, 'utf8');
        selectedPath = p;
        break;
      } catch (e) {}
    }
  }

  if (!loadedContent) {
    return {
      hooks: {
        SessionStart: [],
        UserPromptSubmit: [],
        PreToolUse: [],
        PostToolUse: [],
        ToolFailed: [],
        ApprovalRequested: [],
        ApprovalResolved: [],
        Stop: [],
        CheckpointCreated: [],
        SessionEnd: []
      }
    };
  }

  try {
    const rawJson = JSON.parse(loadedContent);
    const parsed = SettingsSchema.safeParse(rawJson);

    if (!parsed.success) {
      const errorMsg = `Hook Configuration Warning in ${selectedPath}:\n${parsed.error.issues
        .map((e: any) => `- ${e.path.join('.')}: ${e.message}`)
        .join('\n')}`;
      return {
        hooks: {
          SessionStart: [],
          UserPromptSubmit: [],
          PreToolUse: [],
          PostToolUse: [],
          ToolFailed: [],
          ApprovalRequested: [],
          ApprovalResolved: [],
          Stop: [],
          CheckpointCreated: [],
          SessionEnd: []
        },
        diagnostics: errorMsg
      };
    }

    return { hooks: parsed.data.hooks };
  } catch (err: any) {
    return {
      hooks: {
        SessionStart: [],
        UserPromptSubmit: [],
        PreToolUse: [],
        PostToolUse: [],
        ToolFailed: [],
        ApprovalRequested: [],
        ApprovalResolved: [],
        Stop: [],
        CheckpointCreated: [],
        SessionEnd: []
      },
      diagnostics: `Hook Configuration invalid JSON in ${selectedPath}: ${err.message}`
    };
  }
}
