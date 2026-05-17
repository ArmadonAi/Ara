import { z } from 'zod';

export interface CommandContext {
  sessionId?: string;
  apiBaseUrl: string;
  registry?: CommandRegistry;
}

export interface CommandResult {
  success: boolean;
  output: string;
  data?: any;
}

export interface SlashCommand {
  name: string;
  description: string;
  usage: string;
  aliases?: string[];
  inputSchema?: z.ZodSchema<any>;
  category: string;
  requiresApi: boolean;
  dangerLevel: 'safe' | 'write' | 'dangerous';
  handlerType: 'local' | 'api';
  run(args: string[], ctx: CommandContext): Promise<CommandResult>;
}

export class CommandRegistry {
  private commands = new Map<string, SlashCommand>();

  register(command: SlashCommand) {
    this.commands.set(command.name.toLowerCase(), command);
  }

  get(name: string): SlashCommand | undefined {
    const key = name.toLowerCase();
    const cmd = this.commands.get(key);
    if (cmd) return cmd;
    
    // Look up by alias
    return Array.from(this.commands.values()).find(c => 
      c.aliases?.some(alias => alias.toLowerCase() === key)
    );
  }

  getAll(): SlashCommand[] {
    return Array.from(this.commands.values());
  }

  async execute(input: string, ctx: CommandContext): Promise<CommandResult> {
    const trimmed = input.trim();
    if (!trimmed.startsWith('/')) {
      return { success: false, output: 'Not a slash command' };
    }

    const parts = trimmed.split(/\s+/);
    const commandName = parts[0]?.toLowerCase() || '';
    const args = parts.slice(1);

    const cmd = this.get(commandName);
    if (!cmd) {
      return { success: false, output: `Unknown command: ${commandName}. Type /help for a list of commands.` };
    }

    try {
      if (cmd.inputSchema) {
        const parsed = cmd.inputSchema.safeParse(args);
        if (!parsed.success) {
          return { success: false, output: `Invalid arguments for ${commandName}: ${parsed.error.message}` };
        }
      }
      return await cmd.run(args, { ...ctx, registry: this });
    } catch (err: any) {
      return { success: false, output: `Error executing ${commandName}: ${err.message}` };
    }
  }
}

// =========================================================
// Built-in Slash Commands Implementation
// =========================================================

export const HelpCommand: SlashCommand = {
  name: '/help',
  description: 'Display all available slash commands and their usage guides',
  usage: '/help',
  aliases: ['/?', '/h'],
  category: 'general',
  requiresApi: false,
  dangerLevel: 'safe',
  handlerType: 'local',
  async run(_args, ctx) {
    const registry = ctx.registry;
    if (!registry) {
      return { success: false, output: 'Error: Command registry not accessible in context.' };
    }

    let out = `🌟 Ara Slash Commands Guide:\n`;
    out += `-------------------------------------------------------------\n`;
    for (const cmd of registry.getAll()) {
      const aliasStr = cmd.aliases && cmd.aliases.length > 0 ? ` (aliases: ${cmd.aliases.join(', ')})` : '';
      out += `${cmd.name.padEnd(14)} - ${cmd.description}${aliasStr}\n`;
      out += `               Usage: ${cmd.usage}\n`;
    }
    out += `-------------------------------------------------------------`;
    return {
      success: true,
      output: out
    };
  }
};

export const ContextCommand: SlashCommand = {
  name: '/context',
  description: 'View active conversation token usage and context metrics',
  usage: '/context',
  aliases: ['/ctx'],
  category: 'session',
  requiresApi: true,
  dangerLevel: 'safe',
  handlerType: 'api',
  async run(_args, ctx) {
    if (!ctx.sessionId) {
      return { success: false, output: 'No active session loaded.' };
    }
    try {
      const res = await fetch(`${ctx.apiBaseUrl}/api/sessions/${ctx.sessionId}`);
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const session = await res.json() as any;
      const count = session.messages?.length || 0;
      const characters = JSON.stringify(session.messages || []).length;
      return {
        success: true,
        output: `📊 Conversation Context Summary [Session: ${ctx.sessionId}]
-------------------------------------------------------------
Messages count:     ${count}
Estimated size:     ${characters} characters
Buffer status:      ${count > 15 ? '⚠️ Context gets crowded' : '🟢 Optimal'}
-------------------------------------------------------------`,
        data: session
      };
    } catch (err: any) {
      return { success: false, output: `Failed to fetch session context: ${err.message}` };
    }
  }
};

export const CompactCommand: SlashCommand = {
  name: '/compact',
  description: 'Manually compact prior chat logs into a single historical digest',
  usage: '/compact',
  aliases: ['/prune'],
  category: 'session',
  requiresApi: true,
  dangerLevel: 'write',
  handlerType: 'api',
  async run(_args, ctx) {
    if (!ctx.sessionId) {
      return { success: false, output: 'No active session loaded.' };
    }
    try {
      const res = await fetch(`${ctx.apiBaseUrl}/api/sessions/${ctx.sessionId}/compact`, {
        method: 'POST'
      });
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const result = await res.json() as any;
      return {
        success: true,
        output: `✨ Success! ${result.compactedCount} old messages compacted into a single summary block. Context pruned.`,
        data: result
      };
    } catch (err: any) {
      return { success: false, output: `Failed to compact conversation: ${err.message}` };
    }
  }
};

export const ModelCommand: SlashCommand = {
  name: '/model',
  description: 'View current active model profile or toggle to a new provider profile',
  usage: '/model [modelName]',
  aliases: ['/m'],
  category: 'session',
  requiresApi: true,
  dangerLevel: 'write',
  handlerType: 'api',
  inputSchema: z.array(z.string()).max(1),
  async run(args, ctx) {
    try {
      if (args.length > 0) {
        const newModel = args[0]!;
        if (ctx.sessionId) {
          const res = await fetch(`${ctx.apiBaseUrl}/api/sessions/${ctx.sessionId}/config`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ activeModel: newModel })
          });
          if (!res.ok) throw new Error(`Failed to update session model: Status ${res.status}`);
          return {
            success: true,
            output: `🔄 Session model successfully updated to: ${newModel}`
          };
        } else {
          const res = await fetch(`${ctx.apiBaseUrl}/api/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ defaultModel: newModel })
          });
          if (!res.ok) throw new Error(`Failed to update global model config: Status ${res.status}`);
          return {
            success: true,
            output: `🔄 Global default model successfully updated to: ${newModel}`
          };
        }
      } else {
        if (ctx.sessionId) {
          const res = await fetch(`${ctx.apiBaseUrl}/api/sessions/${ctx.sessionId}`);
          if (!res.ok) throw new Error(`Status ${res.status}`);
          const session = await res.json() as any;
          return {
            success: true,
            output: `🤖 Active Session Model: ${session.model || 'Gemini (Default)'}`
          };
        } else {
          const res = await fetch(`${ctx.apiBaseUrl}/api/status`);
          if (!res.ok) throw new Error(`Status ${res.status}`);
          const status = await res.json() as any;
          return {
            success: true,
            output: `🤖 Active Global Default Model: ${status.activeModel || 'gemini-1.5-flash (Mock Mode)'}`
          };
        }
      }
    } catch (err: any) {
      return { success: false, output: `Failed to view or update model: ${err.message}` };
    }
  }
};

export const DoctorCommand: SlashCommand = {
  name: '/doctor',
  description: 'Run workspace health diagnostics and config sanity audits',
  usage: '/doctor',
  aliases: ['/statuscheck'],
  category: 'system',
  requiresApi: true,
  dangerLevel: 'safe',
  handlerType: 'local',
  async run(_args, ctx) {
    try {
      const res = await fetch(`${ctx.apiBaseUrl}/api/status`);
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const status = await res.json() as any;
      return {
        success: true,
        output: `🏥 Ara System Diagnostics Report:
-------------------------------------------------------------
Backend API status:  ONLINE
SQLite DB status:    ${status.database || 'ok'}
Docker Sandbox:      ${status.sandboxMode ? 'ENABLED' : 'DISABLED'}
Loaded Skills:       ${status.skillsCount || 0} markdown modules
Node/Bun Engine:     Bun v${process.version || '1.1.x'}
System CWD:          ${process.cwd()}
-------------------------------------------------------------`
      };
    } catch (err: any) {
      return {
        success: false,
        output: `🚨 Diagnostics failed: Backend API offline or unreachable (${err.message})`
      };
    }
  }
};

export const MemoryCommand: SlashCommand = {
  name: '/memory',
  description: 'View custom context memory and episodic facts',
  usage: '/memory',
  aliases: ['/mem'],
  category: 'memory',
  requiresApi: true,
  dangerLevel: 'safe',
  handlerType: 'api',
  async run(_args, ctx) {
    try {
      const res = await fetch(`${ctx.apiBaseUrl}/api/memories`);
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const memories = await res.json() as any[];
      const output = memories.map(m => `• [${m.type}] ${m.title || 'Memory'}: ${m.content}`).join('\n');
      return {
        success: true,
        output: `🧠 Episodic & Project Memories:
-------------------------------------------------------------
${output || 'No memory records stored in the SQLite database.'}
-------------------------------------------------------------`
      };
    } catch (err: any) {
      return { success: false, output: `Failed to fetch memories: ${err.message}` };
    }
  }
};

export const SkillsCommand: SlashCommand = {
  name: '/skills',
  description: 'List all loaded markdown-based skill procedure cards',
  usage: '/skills',
  aliases: ['/fns'],
  category: 'skills',
  requiresApi: true,
  dangerLevel: 'safe',
  handlerType: 'api',
  async run(_args, ctx) {
    try {
      const res = await fetch(`${ctx.apiBaseUrl}/api/skills`);
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const skills = await res.json() as any[];
      const output = skills.map(s => `🧩 ${s.name} - ${s.description} (Danger: ${s.dangerLevel})`).join('\n');
      return {
        success: true,
        output: `🧩 Registered Progressive Skills:
-------------------------------------------------------------
${output || 'No custom skills registered in workspace.'}
-------------------------------------------------------------`
      };
    } catch (err: any) {
      return { success: false, output: `Failed to fetch skills: ${err.message}` };
    }
  }
};

export const PermissionsCommand: SlashCommand = {
  name: '/permissions',
  description: 'View active permission mode, security allowlists, or toggle current mode',
  usage: '/permissions [mode <mode>]',
  aliases: ['/auth', '/perm'],
  category: 'safety',
  requiresApi: true,
  dangerLevel: 'safe',
  handlerType: 'api',
  async run(args, ctx) {
    try {
      if (args[0] === 'mode' && args[1]) {
        const newMode = args[1].toLowerCase();
        const validModes = ['plan', 'default', 'accept-edits', 'auto-safe', 'danger-review'];
        if (!validModes.includes(newMode)) {
          return {
            success: false,
            output: `🚨 Invalid permission mode: "${newMode}". Expected one of: ${validModes.join(', ')}`
          };
        }

        const res = await fetch(`${ctx.apiBaseUrl}/api/permissions/mode`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: newMode })
        });
        if (!res.ok) throw new Error(`Status ${res.status}`);
        const result = await res.json() as any;
        return {
          success: true,
          output: `🔄 Active permission mode successfully updated to: ${result.mode.toUpperCase()}`
        };
      }

      // Default: fetch permission settings
      const res = await fetch(`${ctx.apiBaseUrl}/api/permissions`);
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const data = await res.json() as any;

      const toolsRes = await fetch(`${ctx.apiBaseUrl}/api/tools`);
      let toolsOutput = '';
      if (toolsRes.ok) {
        const tools = await toolsRes.json() as any[];
        toolsOutput = tools.map(t => `  🔧 ${t.name.padEnd(16)} - Danger Level: ${t.dangerLevel}`).join('\n');
      }

      let out = `🛡️ Ara Personal Permission Engine Status:\n`;
      out += `-------------------------------------------------------------\n`;
      out += `Active Security Mode:  ${data.activeMode.toUpperCase()}\n`;
      out += `Blocked Secrets:       .env, ~/.ssh/**, ~/.aws/**, ~/.config/gcloud/**, private keys\n`;
      out += `Blocked Commands:      rm -rf, sudo, curl | sh, wget | sh, DROP TABLE, env leaks\n`;
      out += `Registered Tools:\n${toolsOutput || '  No tools registered.'}\n`;
      out += `-------------------------------------------------------------\n`;
      out += `Toggle mode using:     /permissions mode <plan|default|accept-edits|auto-safe|danger-review>\n`;
      out += `-------------------------------------------------------------`;

      return {
        success: true,
        output: out
      };
    } catch (err: any) {
      return { success: false, output: `Failed to fetch permissions settings: ${err.message}` };
    }
  }
};

export const HooksCommand: SlashCommand = {
  name: '/hooks',
  description: 'View active lifecycle hooks configuration or validate current settings.json',
  usage: '/hooks [validate]',
  aliases: ['/hk'],
  category: 'system',
  requiresApi: true,
  dangerLevel: 'safe',
  handlerType: 'api',
  inputSchema: z.array(z.string()).max(1),
  async run(args, ctx) {
    const sub = args[0]?.toLowerCase();
    
    if (sub === 'validate') {
      try {
        // Read local settings.json if exists
        const fs = require('node:fs');
        const path = require('node:path');
        let settingsPath = path.join(process.cwd(), '.ara', 'settings.json');
        if (!fs.existsSync(settingsPath)) {
          const os = require('node:os');
          settingsPath = path.join(os.homedir(), '.ara', 'settings.json');
        }

        if (!fs.existsSync(settingsPath)) {
          return { success: false, output: `❌ Error: settings.json config file not found inside local .ara/ or ~/.ara/ directories.` };
        }

        const settingsRaw = fs.readFileSync(settingsPath, 'utf8');
        let settingsJson: any = {};
        try {
          settingsJson = JSON.parse(settingsRaw);
        } catch (e: any) {
          return { success: false, output: `❌ Syntax Error: Failed to parse settings.json JSON formatting: ${e.message}` };
        }

        const res = await fetch(`${ctx.apiBaseUrl}/api/hooks/validate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(settingsJson)
        });

        const data = await res.json() as any;
        if (!res.ok) {
          let out = `❌ Hook Configuration Validation FAILED:\n`;
          out += `-------------------------------------------------------------\n`;
          out += `${data.error}\n`;
          if (data.diagnostics) {
            data.diagnostics.forEach((d: string) => { out += `  - ${d}\n`; });
          }
          out += `-------------------------------------------------------------`;
          return { success: false, output: out };
        } else {
          return {
            success: true,
            output: `✅ Hook Configuration matches Zod schemas flawlessly!\nLocation: ${settingsPath}`
          };
        }
      } catch (e: any) {
        return { success: false, output: `Error validating settings.json config: ${e.message}` };
      }
    }

    // Default: fetch hook settings
    try {
      const res = await fetch(`${ctx.apiBaseUrl}/api/hooks`);
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const data = await res.json() as any;

      let out = `🪝 Ara Active Lifecycle Hooks:\n`;
      out += `-------------------------------------------------------------\n`;
      
      let hasHooks = false;
      const events = Object.keys(data.hooks || {});
      
      events.forEach(evt => {
        const hooksList = data.hooks[evt] || [];
        if (hooksList.length > 0) {
          hasHooks = true;
          out += `Event: ${evt}\n`;
          hooksList.forEach((h: any) => {
            const details = h.type === 'command' 
              ? `[Command: "${h.command}"] (Timeout: ${h.timeoutMs}ms)`
              : `[HTTP POST: "${h.url}"] (Timeout: ${h.timeoutMs}ms)`;
            out += `  └─ Name: ${h.name.padEnd(16)} Type: ${h.type.padEnd(8)} ${details}\n`;
          });
        }
      });

      if (!hasHooks) {
        out += `  No lifecycle hooks configured inside settings.json.\n`;
      }

      if (data.diagnostics && data.diagnostics.length > 0) {
        out += `\n⚠️ Hook Diagnostics:\n${JSON.stringify(data.diagnostics, null, 2)}\n`;
      }

      out += `-------------------------------------------------------------\n`;
      out += `Validate settings using: /hooks validate\n`;
      out += `-------------------------------------------------------------`;

      return {
        success: true,
        output: out
      };
    } catch (err: any) {
      return { success: false, output: `Failed to fetch hooks settings: ${err.message}` };
    }
  }
};

export const CheckpointCommand: SlashCommand = {
  name: '/checkpoint',
  description: 'Manage checkpoints and workspace states',
  usage: '/checkpoint [create <reason> | show <id> | diff <id>]',
  category: 'system',
  requiresApi: true,
  dangerLevel: 'safe',
  handlerType: 'api',
  async run(args, ctx) {
    const sub = args[0]?.toLowerCase();
    
    if (sub === 'create') {
      if (!ctx.sessionId) {
        return { success: false, output: 'No active session loaded.' };
      }
      const reason = args.slice(1).join(' ') || 'Manual Checkpoint via Slash Command';
      try {
        const res = await fetch(`${ctx.apiBaseUrl}/api/sessions/${ctx.sessionId}/checkpoints`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const chk = await res.json() as any;
        return {
          success: true,
          output: `✅ Checkpoint created successfully!\n   ID:        ${chk.id}\n   Reason:    ${chk.reason}\n   Time:      ${chk.createdAt}`
        };
      } catch (err: any) {
        return { success: false, output: `Failed to create checkpoint: ${err.message}` };
      }
    }
    
    if (sub === 'show') {
      const id = args[1];
      if (!id) {
        return { success: false, output: 'Usage: /checkpoint show <checkpointId>' };
      }
      try {
        const res = await fetch(`${ctx.apiBaseUrl}/api/checkpoints/${id}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const chk = await res.json() as any;
        let out = `📌 Checkpoint: ${chk.id}\n`;
        out += `=============================================================\n`;
        out += `Session ID:      ${chk.sessionId}\n`;
        out += `Created By:      ${chk.createdBy}\n`;
        out += `Created At:      ${chk.createdAt}\n`;
        out += `Reason:          ${chk.reason}\n`;
        out += `Git HEAD Commit: ${chk.gitHead || 'n/a'}\n`;
        out += `Message Count:   ${chk.messageCount}\n`;
        out += `Snapshotted:     ${chk.files?.length || 0} files\n`;
        out += `=============================================================`;
        return { success: true, output: out };
      } catch (err: any) {
        return { success: false, output: `Failed to fetch checkpoint: ${err.message}` };
      }
    }
    
    if (sub === 'diff') {
      const id = args[1];
      if (!id) {
        return { success: false, output: 'Usage: /checkpoint diff <checkpointId>' };
      }
      try {
        const res = await fetch(`${ctx.apiBaseUrl}/api/checkpoints/${id}/diff`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const diff = await res.json() as any;
        let out = `🔍 Checkpoint Diff relative to current workspace state: ${id}\n`;
        out += `=============================================================\n`;
        
        const modified = diff.modified || [];
        const created = diff.created || [];
        const deleted = diff.deleted || [];
        const skipped = diff.skipped || [];

        if (modified.length === 0 && created.length === 0 && deleted.length === 0) {
          out += '✨ Workspace is identical to checkpoint state.\n';
        } else {
          if (created.length > 0) {
            out += '\n➕ Created Files:\n';
            created.forEach((f: string) => { out += `  [+] ${f}\n`; });
          }
          if (modified.length > 0) {
            out += '\n~ Modified Files:\n';
            modified.forEach((f: string) => { out += `  [~] ${f}\n`; });
          }
          if (deleted.length > 0) {
            out += '\n➖ Deleted Files:\n';
            deleted.forEach((f: string) => { out += `  [-] ${f}\n`; });
          }
        }
        
        if (skipped.length > 0) {
          out += `\n. Skipped (Large/Binary/Secrets): ${skipped.length} files\n`;
        }
        out += `=============================================================`;
        return { success: true, output: out };
      } catch (err: any) {
        return { success: false, output: `Failed to diff checkpoint: ${err.message}` };
      }
    }
    
    return {
      success: false,
      output: `Unknown subcommand for /checkpoint.\nUsage: /checkpoint [create <reason> | show <id> | diff <id>]`
    };
  }
};

export const CheckpointsCommand: SlashCommand = {
  name: '/checkpoints',
  description: 'List all recent checkpoints in the workspace',
  usage: '/checkpoints',
  category: 'system',
  requiresApi: true,
  dangerLevel: 'safe',
  handlerType: 'api',
  async run(_args, ctx) {
    try {
      const res = await fetch(`${ctx.apiBaseUrl}/api/checkpoints`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list = await res.json() as any[];
      if (!list || list.length === 0) {
        return { success: true, output: '\n🫙 No checkpoints found.\n' };
      }
      let out = `🔒 Recent Checkpoints:\n`;
      out += `=============================================================\n`;
      for (const chk of list) {
        out += `📌 ID:        ${chk.id}\n`;
        out += `   Session:   ${chk.sessionId}\n`;
        out += `   Reason:    ${chk.reason}\n`;
        out += `   Created By: ${chk.createdBy}\n`;
        out += `   Time:      ${chk.createdAt}\n`;
        out += `   Files:     ${chk.files?.length || 0} snapshotted\n`;
        out += `-------------------------------------------------------------\n`;
      }
      return { success: true, output: out };
    } catch (err: any) {
      return { success: false, output: `Failed to list checkpoints: ${err.message}` };
    }
  }
};

export const RestoreCommand: SlashCommand = {
  name: '/restore',
  description: 'Restore code files and/or session history to a checkpoint state',
  usage: '/restore <checkpointId> [code_only | conversation_only | both]',
  category: 'system',
  requiresApi: true,
  dangerLevel: 'dangerous',
  handlerType: 'api',
  async run(args, ctx) {
    const id = args[0];
    if (!id) {
      return { success: false, output: '❌ Usage: /restore <checkpointId> [code_only | conversation_only | both]' };
    }
    const mode = args[1]?.toLowerCase() || 'code_only';
    if (!['code_only', 'conversation_only', 'both'].includes(mode)) {
      return { success: false, output: '❌ Error: Invalid mode. Choose from: code_only, conversation_only, both' };
    }
    
    try {
      const res = await fetch(`${ctx.apiBaseUrl}/api/checkpoints/${id}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode })
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }
      const result = await res.json() as any;
      let out = `✅ Restore successful!\n`;
      if (result.restoredFiles && result.restoredFiles.length > 0) {
        out += `   Restored Files (${result.restoredFiles.length}):\n`;
        result.restoredFiles.forEach((f: string) => { out += `     - ${f}\n`; });
      }
      if (result.messageCount !== undefined) {
        out += `   Conversation rewound to ${result.messageCount} messages.\n`;
      }
      return { success: true, output: out };
    } catch (err: any) {
      return { success: false, output: `Restore failed: ${err.message}` };
    }
  }
};

export const McpHelpCommand: SlashCommand = {
  name: '/mcp',
  description: 'MCP external tools management. Usage: /mcp servers | /mcp tools [serverId] | /mcp health | /mcp start <id> | /mcp stop <id>',
  usage: '/mcp [servers | tools [serverId] | health | start <id> | stop <id>]',
  category: 'mcp',
  requiresApi: true,
  dangerLevel: 'safe',
  handlerType: 'api',
  async run(args, ctx) {
    const sub = args[0]?.toLowerCase();
    try {
      if (sub === 'servers') {
        const res = await fetch(`${ctx.apiBaseUrl}/api/mcp/servers`);
        if (!res.ok) throw new Error(`Status ${res.status}`);
        const data = await res.json() as any;
        const servers = data.servers || [];
        let out = '🔌 MCP Servers:\n';
        out += '=============================================================\n';
        if (servers.length === 0) {
          out += 'No MCP servers configured.\n';
        } else {
          for (const s of servers) {
            out += `  ${s.id}  ${s.enabled ? 'enabled' : 'disabled'}  ${s.trusted ? 'trusted' : 'untrusted'}  mode:${s.permissionMode || 'default'}  ${s.type}\n`;
          }
        }
        return { success: true, output: out };
      }

      if (sub === 'tools') {
        const serverId = args[1];
        const url = serverId
          ? `${ctx.apiBaseUrl}/api/mcp/servers/${serverId}/tools`
          : `${ctx.apiBaseUrl}/api/mcp/tools`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Status ${res.status}`);
        const data = await res.json() as any;
        const tools = data.tools || [];
        let out = `🔧 MCP Tools${serverId ? ` for server "${serverId}"` : ''}:\n`;
        out += '=============================================================\n';
        if (tools.length === 0) {
          out += 'No tools discovered.\n';
        } else {
          for (const t of tools) {
            const fn = t.fullName || `mcp.${t.serverId}.${t.name}`;
            out += `  ${fn}  danger:${t.dangerLevel}  mutating:${t.mutating ? 'yes' : 'no'}\n`;
          }
        }
        return { success: true, output: out };
      }

      if (sub === 'health') {
        const res = await fetch(`${ctx.apiBaseUrl}/api/mcp/health`);
        if (!res.ok) throw new Error(`Status ${res.status}`);
        const data = await res.json() as any;
        const results = data.results || [];
        let out = '💓 MCP Health:\n';
        out += '=============================================================\n';
        if (results.length === 0) {
          out += 'No servers running.\n';
        } else {
          for (const r of results) {
            out += `  ${r.serverId}  state:${r.state}  tools:${r.toolCount}  error:${r.lastError || 'none'}\n`;
          }
        }
        return { success: true, output: out };
      }

      if (sub === 'start' && args[1]) {
        const id = args[1];
        const res = await fetch(`${ctx.apiBaseUrl}/api/mcp/servers/${id}/start`, { method: 'POST' });
        if (!res.ok) throw new Error(`Status ${res.status}`);
        const result = await res.json() as any;
        if (result.ok) {
          return { success: true, output: `✅ Server "${id}" started. ${(result.tools || []).length} tools discovered.` };
        }
        return { success: false, output: `❌ Failed: ${result.error}` };
      }

      if (sub === 'stop' && args[1]) {
        const id = args[1];
        const res = await fetch(`${ctx.apiBaseUrl}/api/mcp/servers/${id}/stop`, { method: 'POST' });
        if (!res.ok) throw new Error(`Status ${res.status}`);
        const result = await res.json() as any;
        if (result.ok) {
          return { success: true, output: `✅ Server "${id}" stopped.` };
        }
        return { success: false, output: `❌ Failed: ${result.error}` };
      }

      // Default: show help
      return {
        success: true,
        output: '🔌 MCP Commands:\n  /mcp servers              - List servers\n  /mcp tools [serverId]    - List tools\n  /mcp health              - Health check\n  /mcp start <id>          - Start server\n  /mcp stop <id>           - Stop server'
      };
    } catch (err: any) {
      return { success: false, output: `Error: ${err.message}` };
    }
  },
};

export const GitHubCommand: SlashCommand = {
  name: '/github',
  description: 'GitHub integration. Usage: /github status | /github issues [owner/repo] | /github prs [owner/repo] | /github checks <ref> [owner/repo]',
  usage: '/github [status | issues | prs | checks <ref>]',
  category: 'github',
  requiresApi: true,
  dangerLevel: 'safe',
  handlerType: 'api',
  async run(args, ctx) {
    const sub = args[0]?.toLowerCase();
    try {
      const base = ctx.apiBaseUrl;

      if (!sub || sub === 'status') {
        const res = await fetch(`${base}/api/github`);
        if (!res.ok) throw new Error(`Status ${res.status}`);
        const d = await res.json() as any;
        return {
          success: true,
          output: `🔗 GitHub: ${d.enabled ? 'Enabled' : 'Disabled'} | Token: ${d.tokenPresent ? 'Yes' : 'No'} | Read-only: ${d.readOnly ? 'Yes' : 'No'} | Default: ${d.defaultOwner || '?'}/${d.defaultRepo || '?'}`
        };
      }

      if (sub === 'issues') {
        const ownerRepo = args[1] || '';
        const [owner = '', repo = ''] = ownerRepo.split('/');
        const res = await fetch(`${base}/api/github/repos/${owner}/${repo}/issues`);
        if (!res.ok) throw new Error(`Status ${res.status}`);
        const d = await res.json() as any;
        if (d.ok) return { success: true, output: `📋 Issues:\n${d.output?.slice(0, 1000) || 'No output'}` };
        return { success: false, output: d.error || 'Failed' };
      }

      if (sub === 'prs') {
        const ownerRepo = args[1] || '';
        const [owner = '', repo = ''] = ownerRepo.split('/');
        const res = await fetch(`${base}/api/github/repos/${owner}/${repo}/pulls`);
        if (!res.ok) throw new Error(`Status ${res.status}`);
        const d = await res.json() as any;
        if (d.ok) return { success: true, output: `🔄 PRs:\n${d.output?.slice(0, 1000) || 'No output'}` };
        return { success: false, output: d.error || 'Failed' };
      }

      if (sub === 'checks' && args[1]) {
        const ref = args[1];
        const ownerRepo = args[2] || '';
        const [owner = '', repo = ''] = ownerRepo.split('/');
        const res = await fetch(`${base}/api/github/repos/${owner}/${repo}/check-runs/${ref}`);
        if (!res.ok) throw new Error(`Status ${res.status}`);
        const d = await res.json() as any;
        if (d.ok) return { success: true, output: `✅ Checks for ${ref}:\n${d.output?.slice(0, 1000) || 'No output'}` };
        return { success: false, output: d.error || 'Failed' };
      }

      return {
        success: true,
        output: '🔗 GitHub Commands:\n  /github status                - Status\n  /github issues [o/r]         - List issues\n  /github prs [o/r]            - List PRs\n  /github checks <ref> [o/r]   - List checks'
      };
    } catch (err: any) {
      return { success: false, output: `Error: ${err.message}` };
    }
  },
};

export const LockCommand: SlashCommand = {
  name: '/locks',
  description: 'File lock management. Usage: /locks cleanup | /locks list',
  usage: '/locks [cleanup | list]',
  category: 'system',
  requiresApi: true,
  dangerLevel: 'safe',
  handlerType: 'api',
  async run(args, ctx) {
    const sub = args[0]?.toLowerCase();
    const base = ctx.apiBaseUrl;
    try {
      if (sub === 'cleanup') {
        const res = await fetch(`${base}/api/locks/cleanup`, { method: 'POST' });
        const d = await res.json() as any;
        return { success: true, output: `🧹 Expired locks cleaned: ${d.cleaned || 0}` };
      }
      if (sub === 'list') {
        const res = await fetch(`${base}/api/locks`);
        const d = await res.json() as any;
        const locks = d.locks || [];
        if (locks.length === 0) return { success: true, output: '🔒 No active locks.' };
        let out = '🔒 Active Locks:\n';
        for (const l of locks) {
          out += `  ${l.id.slice(0, 16)}  ${l.mode}  ${l.path}  owner:${l.agentName || l.sessionId}\n`;
        }
        return { success: true, output };
      }
      return { success: true, output: '🔒 Lock Commands:\n  /locks list         - List active locks\n  /locks cleanup      - Clean expired locks' };
    } catch (err: any) {
      return { success: false, output: `Error: ${err.message}` };
    }
  },
};

export const ParallelCommand: SlashCommand = {
  name: '/parallel',
  description: 'Parallel subagent runs. Usage: /parallel-runs | /parallel <agents> <task>',
  usage: '/parallel <agent1,agent2,...> <task>',
  category: 'subagents',
  requiresApi: true,
  dangerLevel: 'safe',
  handlerType: 'api',
  async run(args, ctx) {
    const base = ctx.apiBaseUrl;
    if (args.length < 2) {
      return { success: true, output: 'Usage: /parallel <agent1,agent2> <task>' };
    }
    const agents = args[0]!.split(',').map(a => a.trim()).filter(Boolean);
    const task = args.slice(1).join(' ');
    try {
      const profileObjects = agents.map(name => ({ name, task }));
      const res = await fetch(`${base}/api/subagents/parallel-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profiles: profileObjects, sessionId: 'slash' })
      });
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const run = await res.json() as any;
      return { success: true, output: `🚀 Parallel run started: ${run.id}\n  Agents: ${agents.join(', ')}\n  Status: ${run.status}` };
    } catch (err: any) {
      return { success: false, output: `Error: ${err.message}` };
    }
  },
};

export const ParallelRunsCommand: SlashCommand = {
  name: '/parallel-runs',
  description: 'List parallel subagent runs',
  usage: '/parallel-runs',
  category: 'subagents',
  requiresApi: true,
  dangerLevel: 'safe',
  handlerType: 'api',
  async run(_args, ctx) {
    try {
      const res = await fetch(`${ctx.apiBaseUrl}/api/subagents/parallel-runs`);
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const data = await res.json() as any;
      const runs = data.runs || [];
      if (runs.length === 0) return { success: true, output: 'No parallel runs.' };
      let out = '🔄 Parallel Runs:\n';
      for (const r of runs) {
        out += `  ${r.id.slice(0, 16)}  status:${r.status}  profiles:${(r.profiles || []).length}  results:${(r.results || []).length}\n`;
      }
      return { success: true, output };
    } catch (err: any) {
      return { success: false, output: `Error: ${err.message}` };
    }
  },
};


export const CanvasCommand: SlashCommand = {
  name: '/canvas',
  description: 'Canvas workspace management. Usage: /canvas list | /canvas create <name> | /canvas show <id> | /canvas export <id>',
  usage: '/canvas [list | create <name> | show <id> | export <id>]',
  category: 'canvas',
  requiresApi: true,
  dangerLevel: 'safe',
  handlerType: 'api',
  async run(args, ctx) {
    const sub = args[0]?.toLowerCase();
    const base = ctx.apiBaseUrl;
    try {
      if (!sub || sub === 'list') {
        const res = await fetch(base + '/api/canvas/workspaces');
        if (!res.ok) throw new Error('Status ' + res.status);
        const d = await res.json() as any;
        const ws = d.workspaces || [];
        if (ws.length === 0) return { success: true, output: 'No canvas workspaces. Create one: /canvas create "My Workspace"' };
        let out = '';
        for (const w of ws) {
          out += '  ' + (w.id || '').slice(0, 12) + '  ' + (w.name || '').slice(0, 30) + '  ' + (w.createdAt || '').slice(0, 10);
        }
        return { success: true, output };
      }
      if (sub === 'create') {
        const name = args.slice(1).join(' ');
        if (!name) return { success: false, output: 'Usage: /canvas create <workspace name>' };
        const res = await fetch(base + '/api/canvas/workspaces', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        if (!res.ok) throw new Error('Status ' + res.status);
        const result = await res.json() as any;
        return { success: true, output: 'Workspace created: ' + result.id };
      }
      if (sub === 'show' && args[1]) {
        const id = args[1];
        const res = await fetch(base + '/api/canvas/workspaces/' + id);
        if (!res.ok) throw new Error('Status ' + res.status);
        const data = await res.json() as any;
        const ws = data.workspace || {};
        const nodes = data.nodes || [];
        const edges = data.edges || [];
        return { success: true, output: 'Workspace: ' + (ws.name || '') + '  Nodes: ' + nodes.length + '  Edges: ' + edges.length };
      }
      if (sub === 'export' && args[1]) {
        const id = args[1];
        const res = await fetch(base + '/api/canvas/workspaces/' + id + '/export');
        if (!res.ok) throw new Error('Status ' + res.status);
        const data = await res.json() as any;
        return { success: true, output: 'Workspace exported: ' + (data.nodes?.length || 0) + ' nodes, ' + (data.edges?.length || 0) + ' edges' };
      }
      return {
        success: true,
        output: 'Canvas Commands: /canvas list | /canvas create <name> | /canvas show <id> | /canvas export <id>'
      };
    } catch (err: any) {
      return { success: false, output: 'Error: ' + err.message };
    }
  },
};


export const SkillsLearningCommand: SlashCommand = {
  name: '/skills',
  description: 'Skill learning: detect workflows, manage drafts. Usage: /skills suggest | /skills drafts | /skills approve <id> | /skills reject <id>',
  usage: '/skills [suggest | drafts | approve <id> | reject <id> | stats]',
  category: 'skills',
  requiresApi: true,
  dangerLevel: 'write',
  handlerType: 'api',
  async run(args, ctx) {
    const sub = args[0]?.toLowerCase();
    const base = ctx.apiBaseUrl;
    try {
      if (!sub || sub === 'suggest') {
        const res = await fetch(base + '/api/skill-learning');
        if (!res.ok) throw new Error('Status ' + res.status);
        const d = await res.json() as any;
        return { success: true, output: 'Learning Loop: ' + (d.workflowCount || 0) + ' workflows, ' + (d.repeatedCount || 0) + ' repeated, ' + (d.draftCount || 0) + ' drafts' };
      }

      if (sub === 'drafts' && !args[1]) {
        const res = await fetch(base + '/api/skill-learning/drafts');
        if (!res.ok) throw new Error('Status ' + res.status);
        const data = await res.json() as any;
        const drafts = data.drafts || [];
        if (drafts.length === 0) return { success: true, output: 'No skill drafts. Run /skills suggest' };
        let out = 'Skill Drafts:\n';
        for (const d of drafts) {
          out += '  ' + (d.id || '').slice(0, 12) + '  ' + (d.status || '').padEnd(10) + '  ' + (d.proposedSkillName || '').slice(0, 20) + '  ' + Math.round((d.confidence || 0) * 100) + '%\n';
        }
        return { success: true, output };
      }

      if (sub === 'approve' && args[1]) {
        const id = args[1];
        const res = await fetch(base + '/api/skill-learning/drafts/' + id + '/approve', { method: 'POST' });
        if (!res.ok) throw new Error('Status ' + res.status);
        const result = await res.json() as any;
        if (result.ok) return { success: true, output: 'Draft approved: ' + result.skillName + ' v' + result.version };
        return { success: false, output: result.error || 'Approval failed' };
      }

      if (sub === 'reject' && args[1]) {
        const id = args[1];
        const res = await fetch(base + '/api/skill-learning/drafts/' + id + '/reject', { method: 'POST' });
        if (!res.ok) throw new Error('Status ' + res.status);
        const result = await res.json() as any;
        if (result.ok) return { success: true, output: 'Draft rejected: ' + id };
        return { success: false, output: result.error || 'Rejection failed' };
      }

      if (sub === 'stats') {
        const res = await fetch(base + '/api/skill-learning/stats');
        if (!res.ok) throw new Error('Status ' + res.status);
        const data = await res.json() as any;
        const stats = data.stats || [];
        if (stats.length === 0) return { success: true, output: 'No usage stats recorded.' };
        let out = 'Skill Stats:\n';
        for (const s of stats) {
          out += '  ' + (s.skillName || '').padEnd(20) + ' uses:' + (s.useCount || 0) + ' ok:' + (s.successCount || 0) + ' fail:' + (s.failureCount || 0) + '\n';
        }
        return { success: true, output };
      }

      return {
        success: true,
        output: 'Skills commands: /skills suggest | /skills drafts | /skills approve <id> | /skills reject <id> | /skills stats'
      };
    } catch (err: any) {
      return { success: false, output: 'Error: ' + err.message };
    }
  },
};

export const RewindCommand: SlashCommand = {
  name: '/rewind',
  description: 'Print recent checkpoints and provide exact restore instructions',
  usage: '/rewind',
  category: 'system',
  requiresApi: true,
  dangerLevel: 'safe',
  handlerType: 'api',
  async run(_args, ctx) {
    try {
      const res = await fetch(`${ctx.apiBaseUrl}/api/checkpoints`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list = await res.json() as any[];
      if (!list || list.length === 0) {
        return { success: true, output: '\n🫙 No checkpoints available to rewind.\n' };
      }
      let out = `⏪ Rewind / Rollback Helper:\n`;
      out += `=============================================================\n`;
      out += `To rewind to a checkpoint, execute the corresponding command below:\n\n`;
      for (const chk of list.slice(0, 10)) {
        out += `📌 Checkpoint ID: ${chk.id}\n`;
        out += `   Reason:        ${chk.reason}\n`;
        out += `   Created At:    ${chk.createdAt}\n`;
        out += `   Restore Commands:\n`;
        out += `     >  /restore ${chk.id} code_only          (Restore workspace files only)\n`;
        out += `     >  /restore ${chk.id} conversation_only  (Rewind chat messages only)\n`;
        out += `     >  /restore ${chk.id} both               (Restore both files & chat)\n`;
        out += `-------------------------------------------------------------\n`;
      }
      return { success: true, output: out };
    } catch (err: any) {
      return { success: false, output: `Failed to get rewind checkpoints list: ${err.message}` };
    }
  }
};

// Create a helper registry factory with all built-in commands pre-registered
export function createDefaultRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registry.register(HelpCommand);
  registry.register(ContextCommand);
  registry.register(CompactCommand);
  registry.register(ModelCommand);
  registry.register(DoctorCommand);
  registry.register(MemoryCommand);
  registry.register(SkillsCommand);
  registry.register(PermissionsCommand);
  registry.register(HooksCommand);
  registry.register(CheckpointCommand);
  registry.register(CheckpointsCommand);
  registry.register(RestoreCommand);
  registry.register(SkillsLearningCommand);
  registry.register(RewindCommand);
  registry.register(McpHelpCommand);
  registry.register(GitHubCommand);
  registry.register(LockCommand);
  registry.register(ParallelCommand);
  registry.register(ParallelRunsCommand);
  registry.register(CanvasCommand);
  return registry;
}
