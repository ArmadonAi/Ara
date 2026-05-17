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
  return registry;
}
