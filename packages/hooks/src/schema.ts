import { z } from 'zod';

export const HookTypeSchema = z.enum(['command', 'http']);

export const BaseHookSchema = z.object({
  name: z.string().min(1, 'Hook name must not be empty'),
  type: HookTypeSchema,
  matcher: z.string().optional(),
  timeoutMs: z.number().int().positive().optional().default(10000),
});

export const CommandHookSchema = BaseHookSchema.extend({
  type: z.literal('command'),
  command: z.string().min(1, 'Command must not be empty'),
});

export const HttpHookSchema = BaseHookSchema.extend({
  type: z.literal('http'),
  url: z.string().url('URL must be a valid HTTP/HTTPS URL'),
  headers: z.record(z.string()).optional(),
});

export const HookSchema = z.discriminatedUnion('type', [CommandHookSchema, HttpHookSchema]);

export const HooksMapSchema = z.object({
  SessionStart: z.array(HookSchema).default([]),
  UserPromptSubmit: z.array(HookSchema).default([]),
  PreToolUse: z.array(HookSchema).default([]),
  PostToolUse: z.array(HookSchema).default([]),
  ToolFailed: z.array(HookSchema).default([]),
  ApprovalRequested: z.array(HookSchema).default([]),
  ApprovalResolved: z.array(HookSchema).default([]),
  Stop: z.array(HookSchema).default([]),
  SessionEnd: z.array(HookSchema).default([]),
});

export const SettingsSchema = z.object({
  hooks: HooksMapSchema.default({
    SessionStart: [],
    UserPromptSubmit: [],
    PreToolUse: [],
    PostToolUse: [],
    ToolFailed: [],
    ApprovalRequested: [],
    ApprovalResolved: [],
    Stop: [],
    SessionEnd: []
  }),
});
