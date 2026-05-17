#!/usr/bin/env bun
import React from 'react';
import { render } from 'ink';
import { Command } from 'commander';
import * as readline from 'readline';

import { ApiClient } from './api/client';
import { loadConfig, saveConfig, setApiBaseUrl, getApiBaseUrl } from './config/manager';
import { TuiApp } from './components/TuiApp';

const program = new Command();
const client = new ApiClient();

function askUser(query: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise(resolve => rl.question(query, ans => {
    rl.close();
    resolve(ans);
  }));
}

// -------------------------------------------------------------
// 1. Default action (Open TUI)
// -------------------------------------------------------------
program
  .name('ara')
  .description('Ara Personal AI Control Plane - CLI/TUI Gateway')
  .version('0.1.0')
  .action(() => {
    // Standard TUI Mount
    render(<TuiApp />);
  });

// -------------------------------------------------------------
// 2. Command: ara tui
// -------------------------------------------------------------
program
  .command('tui')
  .description('Open full screen Ink TUI Dashboard')
  .action(() => {
    render(<TuiApp />);
  });

// -------------------------------------------------------------
// 3. Command: ara chat [prompt]
// -------------------------------------------------------------
program
  .command('chat [prompt]')
  .description('Open interactive console chat or run a one-shot prompt')
  .action(async (prompt) => {
    if (prompt) {
      // One-shot mode
      try {
        const config = loadConfig();
        let sessId = config.defaultSessionId;
        if (!sessId) {
          const newSess = await client.createSession('Gemini', 'CLI One-Shot Session');
          sessId = newSess.id;
          config.defaultSessionId = sessId;
          saveConfig(config);
        }

        process.stdout.write(`\nAra [Session: ${sessId}]: `);
        let hasApproval = false;

        for await (const chunk of client.streamMessage(sessId, prompt)) {
          if (chunk.type === 'message.delta') {
            process.stdout.write(chunk.text);
          } else if (chunk.type === 'approval.required') {
            hasApproval = true;
            console.log('\n\n[🛡️ Approval Required] Action was paused.');
            console.log('To authorize this action, run the following command:');
            console.log(`  ara approve ${chunk.approvalId || '<approvalId>'}`);
            break;
          } else if (chunk.type === 'error') {
            console.error(`\nError: ${chunk.message}`);
          }
        }
        console.log('\n');
      } catch (e: any) {
        console.error(`\nOffline Error: Ara API server is not running at ${getApiBaseUrl()}`);
        console.error('Start it with:  bun run dev:api');
      }
    } else {
      // Interactive Mode
      try {
        const config = loadConfig();
        let sessId = config.defaultSessionId;
        if (!sessId) {
          const newSess = await client.createSession('Gemini', 'CLI Interactive Session');
          sessId = newSess.id;
          config.defaultSessionId = sessId;
          saveConfig(config);
        }

        console.log(`💬 Interactive Chat Active. Session: ${sessId}`);
        console.log('Type "exit" or "quit" to leave conversation.\n');

        while (true) {
          const userPrompt = await askUser('You: ');
          if (!userPrompt || userPrompt.toLowerCase() === 'exit' || userPrompt.toLowerCase() === 'quit') {
            console.log('Goodbye!');
            break;
          }

          process.stdout.write('\nAra: ');
          for await (const chunk of client.streamMessage(sessId, userPrompt)) {
            if (chunk.type === 'message.delta') {
              process.stdout.write(chunk.text);
            } else if (chunk.type === 'approval.required') {
              console.log('\n\n[🛡️ Approval Paused] Tool requires authentication.');
              console.log(`  To approve, run:  ara approve <id>`);
              break;
            } else if (chunk.type === 'error') {
              console.error(`\nError: ${chunk.message}`);
            }
          }
          console.log('\n');
        }
      } catch (e: any) {
        console.error(`Offline Error: Ara API server is not running at ${getApiBaseUrl()}`);
      }
    }
  });

// -------------------------------------------------------------
// 4. Command: ara sessions
// -------------------------------------------------------------
program
  .command('sessions')
  .description('List previous chat sessions')
  .action(async () => {
    try {
      const list = await client.listSessions();
      console.log('\n💬 Previous Chat Sessions:');
      console.log('-------------------------------------------------------------');
      list.forEach(s => {
        console.log(`Session ID: ${s.id}`);
        console.log(`Title:      ${s.title}`);
        console.log(`Model:      ${s.model}`);
        console.log(`Messages:   ${s.messageCount}`);
        console.log('-------------------------------------------------------------');
      });
    } catch (e) {
      console.error(`Offline Error: Ara API server is not running at ${getApiBaseUrl()}`);
    }
  });

// -------------------------------------------------------------
// 5. Command: ara session <id>
// -------------------------------------------------------------
program
  .command('session <id>')
  .description('View detailed message history of a specific session')
  .action(async (id) => {
    try {
      const sess = await client.getSession(id);
      console.log(`\n💬 Conversation: "${sess.title}" (Model: ${sess.model})`);
      console.log('=============================================================');
      sess.messages?.forEach(m => {
        const roleName = m.role === 'user' ? 'User' : m.role === 'system' ? 'System' : 'Ara';
        console.log(`[${roleName}]: ${m.content}\n`);
      });
    } catch (e) {
      console.error(`Error: Session "${id}" not found or API server offline.`);
    }
  });

// -------------------------------------------------------------
// 6. Command: ara approvals
// -------------------------------------------------------------
program
  .command('approvals')
  .description('List all pending tools execution approvals')
  .action(async () => {
    try {
      const list = await client.listApprovals();
      const pendings = list.filter(a => a.status === 'pending');
      console.log(`\n🛡️ Pending Approvals Gate (${pendings.length}):`);
      console.log('-------------------------------------------------------------');
      pendings.forEach(a => {
        console.log(`Approval ID: ${a.id}`);
        console.log(`Tool Name:   ${a.toolName}`);
        console.log(`Risk Level:  ${a.riskLevel}`);
        console.log(`Reason:      ${a.reason}`);
        console.log(`Arguments:   ${a.input}`);
        console.log('-------------------------------------------------------------');
      });
    } catch (e) {
      console.error(`Offline Error: Ara API server is not running.`);
    }
  });

// -------------------------------------------------------------
// 7. Command: ara approve <approvalId>
// -------------------------------------------------------------
program
  .command('approve <approvalId>')
  .description('Approve a pending tool execution')
  .action(async (approvalId) => {
    try {
      const res = await client.approveRequest(approvalId);
      console.log(`✅ Approved. Tool execution completed successfully.`);
      if (res.output) {
        console.log(`\nOutput:\n${res.output}`);
      }
    } catch (e: any) {
      console.error(`Error resolving approval: ${e.message}`);
    }
  });

// -------------------------------------------------------------
// 8. Command: ara reject <approvalId>
// -------------------------------------------------------------
program
  .command('reject <approvalId>')
  .description('Reject a pending tool execution')
  .action(async (approvalId) => {
    try {
      await client.rejectRequest(approvalId);
      console.log(`❌ Rejected. Tool execution blocked successfully.`);
    } catch (e: any) {
      console.error(`Error resolving approval: ${e.message}`);
    }
  });

// -------------------------------------------------------------
// 9. Command: ara memory
// -------------------------------------------------------------
program
  .command('memory [query]')
  .description('List or search episodic memories')
  .action(async (query) => {
    try {
      const list = query ? await client.searchMemory(query) : await client.listMemory();
      console.log(`\n🧠 Memory Facts (${list.length}):`);
      console.log('-------------------------------------------------------------');
      list.forEach(m => {
        console.log(`[${m.type.toUpperCase()}] ${m.title}: ${m.content}`);
      });
    } catch (e) {
      console.error(`Offline Error: Ara API server offline.`);
    }
  });

// -------------------------------------------------------------
// 10. Command: ara skills
// -------------------------------------------------------------
program
  .command('skills')
  .description('List available Markdown skills')
  .action(async () => {
    try {
      const list = await client.listSkills();
      console.log(`\n🧠 Executable Skills Loaded (${list.length}):`);
      console.log('-------------------------------------------------------------');
      list.forEach(s => {
        console.log(`Skill Name:  ${s.name} (${s.dangerLevel})`);
        console.log(`Description: ${s.description}`);
        console.log('-------------------------------------------------------------');
      });
    } catch (e) {
      console.error(`Offline Error.`);
    }
  });

// -------------------------------------------------------------
// 11. Command: ara tools
// -------------------------------------------------------------
program
  .command('tools')
  .description('List registered sandbox tools')
  .action(async () => {
    try {
      const list = await client.listTools();
      console.log('\n🛠️ Sandbox Tool Signatures:');
      list.forEach(t => console.log(`- ${t}`));
    } catch (e) {
      console.error(`Offline Error.`);
    }
  });

// -------------------------------------------------------------
// 12. Command: ara audit
// -------------------------------------------------------------
program
  .command('audit')
  .description('Show recent tool execution audit logs')
  .action(async () => {
    try {
      const logs = await client.listAuditLogs();
      console.log('\n📜 Immutable Audit Logs Trace:');
      console.log('-------------------------------------------------------------');
      logs.slice(0, 15).forEach(l => {
        const icon = l.status === 'success' ? '✅' : '❌';
        console.log(`${icon} [${l.createdAt.slice(11, 19)}] Tool: ${l.toolName}`);
        console.log(`   Args:   ${l.input}`);
        console.log(`   Output: ${l.output.slice(0, 100)}...`);
        console.log('-------------------------------------------------------------');
      });
    } catch (e) {
      console.error(`Offline Error.`);
    }
  });

// -------------------------------------------------------------
// 13. Command: ara status
// -------------------------------------------------------------
program
  .command('status')
  .description('Show Hono API server, DB, and Sandbox status')
  .action(async () => {
    try {
      const stat = await client.getStatus();
      console.log('\n🖥️ Ara Plane Status parameters:');
      console.log('-------------------------------------------------------------');
      console.log(`API Status:             ONLINE`);
      console.log(`API Gateway Version:    ${stat.version}`);
      console.log(`SQLite DB Status:       ${stat.database}`);
      console.log(`Docker Sandbox Mode:    ${stat.sandboxMode ? 'ENABLED' : 'DISABLED'}`);
      console.log(`Skills count:           ${stat.skillsCount}`);
      console.log(`Memory Ingestion:       ${stat.memoryEnabled ? 'ENABLED' : 'DISABLED'}`);
      console.log(`Pending Approvals:      ${stat.pendingApprovalsCount}`);
      console.log('-------------------------------------------------------------');
    } catch (e) {
      console.log('\n🖥️ Ara Plane Status parameters:');
      console.log('-------------------------------------------------------------');
      console.log(`API Status:             OFFLINE ❌`);
      console.log(`Base URL:               ${getApiBaseUrl()}`);
      console.log('Please start the Hono gateway API:  bun run dev:api');
      console.log('-------------------------------------------------------------');
    }
  });

// -------------------------------------------------------------
// 15. Command: ara resume [sessionId]
// -------------------------------------------------------------
program
  .command('resume [sessionId]')
  .description('Resume a previous active or targeted session log')
  .action(async (sessionId) => {
    try {
      const config = loadConfig();
      const id = sessionId || config.defaultSessionId;
      if (!id) {
        console.error('Error: No session ID provided and no default session registered.');
        return;
      }

      await client.resumeSession(id);
      config.defaultSessionId = id;
      saveConfig(config);
      console.log(`✅ Session "${id}" resumed and successfully marked active.`);
    } catch (e: any) {
      console.error(`Error resuming session: ${e.message}`);
    }
  });

// -------------------------------------------------------------
// 16. Command: ara fork [sessionId] [messageIndex]
// -------------------------------------------------------------
program
  .command('fork [sessionId] [messageIndex]')
  .description('Fork chat session history up to a specific message count')
  .action(async (sessionId, messageIndex) => {
    try {
      const config = loadConfig();
      const id = sessionId || config.defaultSessionId;
      if (!id) {
        console.error('Error: No target session ID available to fork.');
        return;
      }

      const idx = messageIndex !== undefined ? parseInt(messageIndex, 10) : 9999;
      const forked = await client.forkSession(id, idx);
      
      config.defaultSessionId = forked.id;
      saveConfig(config);

      console.log(`✨ Conversation history successfully forked!`);
      console.log(`New session ID: ${forked.id}`);
      console.log(`Active default session updated to this fork.`);
    } catch (e: any) {
      console.error(`Error forking session: ${e.message}`);
    }
  });

// -------------------------------------------------------------
// 17. Command: ara context
// -------------------------------------------------------------
program
  .command('context')
  .description('Show estimated tokens and active session context statistics')
  .action(async () => {
    try {
      const config = loadConfig();
      const id = config.defaultSessionId;
      if (!id) {
        console.error('No active session. Open ara chat to start.');
        return;
      }

      const sess = await client.getSession(id);
      const count = sess.messages?.length || 0;
      const size = JSON.stringify(sess.messages || []).length;
      console.log(`\n📊 Active Session Context: ${id}`);
      console.log('-------------------------------------------------------------');
      console.log(`Total Messages:     ${count}`);
      console.log(`Estimated Tokens:   ${Math.round(size / 4)}`);
      console.log(`Buffer Status:      ${count > 15 ? '⚠️ High' : '🟢 Pruned & Prudent'}`);
      console.log('-------------------------------------------------------------');
    } catch (e: any) {
      console.error(`Error fetching context parameters: ${e.message}`);
    }
  });

// -------------------------------------------------------------
// 18. Command: ara compact
// -------------------------------------------------------------
program
  .command('compact')
  .description('Manually trigger compaction of old messages in active session')
  .action(async () => {
    try {
      const config = loadConfig();
      const id = config.defaultSessionId;
      if (!id) {
        console.error('No active session.');
        return;
      }

      const res = await client.compactSession(id);
      console.log(`✨ Compaction completed: ${res.compactedCount} old messages compiled into single summary block.`);
    } catch (e: any) {
      console.error(`Error compacting active conversation context: ${e.message}`);
    }
  });

// -------------------------------------------------------------
// 19. Command: ara doctor
// -------------------------------------------------------------
program
  .command('doctor')
  .description('Audit environment, paths, and SQLite databases integrity')
  .action(async () => {
    try {
      const stat = await client.getStatus();
      console.log(`\n🏥 Ara Diagnostics:`);
      console.log('-------------------------------------------------------------');
      console.log(`API Gateway:   ONLINE`);
      console.log(`SQLite status: ${stat.database}`);
      console.log(`Sandbox mode:  ${stat.sandboxMode ? 'ENABLED' : 'DISABLED'}`);
      console.log(`Active skills: ${stat.skillsCount}`);
      console.log(`Workspace CWD: ${process.cwd()}`);
      console.log('-------------------------------------------------------------');
    } catch (e: any) {
      console.log(`\n🏥 Ara Diagnostics:`);
      console.log('-------------------------------------------------------------');
      console.log(`API Gateway:   OFFLINE ❌`);
      console.log(`Diagnostics:   Ensure hono server is run locally via port 3001`);
      console.log('-------------------------------------------------------------');
    }
  });

// -------------------------------------------------------------
// 20. Command: ara model <model>
// -------------------------------------------------------------
program
  .command('model <model>')
  .description('Update the active model of the current chat session')
  .action(async (newModel) => {
    try {
      const config = loadConfig();
      const sessionId = config.defaultSessionId;
      if (!sessionId) {
        console.error('Error: No active session loaded. Switch global model config or start a chat first.');
        return;
      }
      
      const res = await fetch(`${getApiBaseUrl()}/api/sessions/${sessionId}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activeModel: newModel })
      });
      
      if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
      console.log(`🔄 Session model successfully updated to: ${newModel}`);
    } catch (e: any) {
      console.error(`Error updating session model: ${e.message}`);
    }
  });

// -------------------------------------------------------------
// 21. Command: ara transcript <sessionId>
// -------------------------------------------------------------
program
  .command('transcript <sessionId>')
  .description('Retrieve incremental transcript event logs of a targeted session')
  .option('--rebuild', 'Explicitly rebuild database messages from the transcript history')
  .action(async (sessionId, options) => {
    try {
      if (options.rebuild) {
        const res = await fetch(`${getApiBaseUrl()}/api/sessions/${sessionId}/transcript/rebuild`, {
          method: 'POST'
        });
        if (!res.ok) {
          const err = await res.json() as any;
          console.error(`❌ Rebuild failed:`, err.errors || err);
          return;
        }
        console.log(`✅ Success! Database messages successfully rebuilt from transcript event history.`);
      } else {
        const res = await fetch(`${getApiBaseUrl()}/api/sessions/${sessionId}/transcript`);
        if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
        const records = await res.json() as any[];
        console.log(`\n📜 Incremental Transcript Events for session: ${sessionId}`);
        console.log('-------------------------------------------------------------');
        records.forEach(r => {
          console.log(`[Seq: ${r.seq}] [${r.eventType}] @ ${r.timestamp}`);
          if (r.eventType === 'message.appended' && r.payload?.message) {
            console.log(`   └─ ${r.payload.message.role}: ${r.payload.message.content.slice(0, 80)}...`);
          }
        });
        console.log('-------------------------------------------------------------');
      }
    } catch (e: any) {
      console.error(`Error fetching transcript events: ${e.message}`);
    }
  });

// -------------------------------------------------------------
// 14. Command: ara config [key] [value]
// -------------------------------------------------------------
program
  .command('config [key] [value]')
  .description('View or edit CLI configuration parameters')
  .action(async (key, value) => {
    const config = loadConfig();
    if (!key) {
      console.log('\n🛠️ CLI Configuration settings:');
      console.log('-------------------------------------------------------------');
      console.log(JSON.stringify(config, null, 2));
      console.log('-------------------------------------------------------------');
    } else {
      let targetKey = key;
      if (key === 'model') {
        targetKey = 'defaultModel';
      }
      
      if (targetKey in config || targetKey === 'defaultModel') {
        if (value !== undefined) {
          if (targetKey === 'apiBaseUrl') {
            setApiBaseUrl(value);
            console.log(`apiBaseUrl set to ${value}`);
          } else {
            (config as any)[targetKey] = value;
            saveConfig(config);
            console.log(`config.${targetKey} updated successfully.`);
            
            if (targetKey === 'defaultModel') {
              try {
                await client.updateModelConfig(value);
                console.log(`🔄 Global default model synchronized in Hono backend.`);
              } catch (err) {}
            }
          }
        } else {
          console.log(`${targetKey}: ${(config as any)[targetKey]}`);
        }
      } else {
        console.error(`Error: Config option "${targetKey}" does not exist.`);
      }
    }
  });

// -------------------------------------------------------------
// 22. Command: ara permissions [mode]
// -------------------------------------------------------------
program
  .command('permissions [mode]')
  .description('View active permission mode, default deny lists, or update current mode')
  .action(async (mode) => {
    try {
      if (mode) {
        const newMode = mode.toLowerCase();
        const validModes = ['plan', 'default', 'accept-edits', 'auto-safe', 'danger-review'];
        if (!validModes.includes(newMode)) {
          console.error(`🚨 Invalid permission mode: "${newMode}". Expected one of: ${validModes.join(', ')}`);
          return;
        }

        const res = await fetch(`${getApiBaseUrl()}/api/permissions/mode`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: newMode })
        });
        
        if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
        const result = await res.json() as any;
        console.log(`🔄 Active permission mode successfully updated to: ${result.mode.toUpperCase()}`);
      } else {
        const res = await fetch(`${getApiBaseUrl()}/api/permissions`);
        if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
        const data = await res.json() as any;

        const toolsRes = await fetch(`${getApiBaseUrl()}/api/tools`);
        let toolsOutput = '';
        if (toolsRes.ok) {
          const tools = await toolsRes.json() as any[];
          toolsOutput = tools.map(t => `  🔧 ${t.name.padEnd(16)} - Danger Level: ${t.dangerLevel}`).join('\n');
        }

        console.log(`\n🛡️ Ara Personal Permission Engine Status:`);
        console.log('-------------------------------------------------------------');
        console.log(`Active Security Mode:  ${data.activeMode.toUpperCase()}`);
        console.log(`Blocked Secrets:       .env, ~/.ssh/**, ~/.aws/**, ~/.config/gcloud/**, private keys`);
        console.log(`Blocked Commands:      rm -rf, sudo, curl | sh, wget | sh, DROP TABLE, env leaks`);
        console.log(`\nRegistered Tools:`);
        console.log(toolsOutput || '  No tools registered.');
        console.log('-------------------------------------------------------------');
        console.log(`Toggle mode using:     ara permissions <plan|default|accept-edits|auto-safe|danger-review>`);
        console.log('-------------------------------------------------------------');
      }
    } catch (e: any) {
      console.error(`Error updating permissions setting: ${e.message}`);
    }
  });

// -------------------------------------------------------------
// 23. Command: ara hooks [action] [event]
// -------------------------------------------------------------
program
  .command('hooks [action] [event]')
  .description('Manage, validate, or test lifecycle hooks config (actions: list, validate, test)')
  .action(async (action, event) => {
    const act = (action || 'list').toLowerCase();
    
    if (act === 'list') {
      try {
        const res = await fetch(`${getApiBaseUrl()}/api/hooks`);
        if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
        const data = await res.json() as any;

        console.log(`\n🪝 Ara Lifecycle Hooks configuration status:`);
        console.log('-------------------------------------------------------------');
        
        let hasHooks = false;
        const events = Object.keys(data.hooks || {});
        
        events.forEach(evt => {
          const hooksList = data.hooks[evt] || [];
          if (hooksList.length > 0) {
            hasHooks = true;
            console.log(`Event: ${evt}`);
            hooksList.forEach((h: any) => {
              const details = h.type === 'command' 
                ? `[Command: "${h.command}"] (Timeout: ${h.timeoutMs}ms)`
                : `[HTTP POST: "${h.url}"] (Timeout: ${h.timeoutMs}ms)`;
              console.log(`  └─ Name: ${h.name.padEnd(16)} Type: ${h.type.padEnd(8)} ${details}`);
            });
          }
        });

        if (!hasHooks) {
          console.log('  No lifecycle hooks configured inside settings.json.');
        }

        if (data.diagnostics && data.diagnostics.length > 0) {
          console.log('\n⚠️ Hook Diagnostics:');
          console.log(data.diagnostics);
        }
        
        console.log('-------------------------------------------------------------');
        console.log(`Validate settings:     ara hooks validate`);
        console.log(`Test a hook event:     ara hooks test <event>`);
        console.log('-------------------------------------------------------------');
      } catch (e: any) {
        console.error(`Error listing hooks status: ${e.message}`);
      }
    } else if (act === 'validate') {
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
          console.log(`❌ Error: settings.json config file not found inside local .ara/ or ~/.ara/ directories.`);
          return;
        }

        const settingsRaw = fs.readFileSync(settingsPath, 'utf8');
        let settingsJson: any = {};
        try {
          settingsJson = JSON.parse(settingsRaw);
        } catch (e: any) {
          console.error(`❌ Syntax Error: Failed to parse settings.json JSON formatting: ${e.message}`);
          return;
        }

        const res = await fetch(`${getApiBaseUrl()}/api/hooks/validate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(settingsJson)
        });

        const data = await res.json() as any;
        if (!res.ok) {
          console.log(`\n❌ Hook Configuration Validation FAILED:`);
          console.log('-------------------------------------------------------------');
          console.log(data.error);
          if (data.diagnostics) {
            data.diagnostics.forEach((d: string) => console.log(`  - ${d}`));
          }
          console.log('-------------------------------------------------------------');
        } else {
          console.log(`\n✅ Hook Configuration matches Zod schemas flawlessly!`);
          console.log(`Location: ${settingsPath}`);
          console.log('-------------------------------------------------------------');
        }
      } catch (e: any) {
        console.error(`Error validating settings.json config: ${e.message}`);
      }
    } else if (act === 'test') {
      if (!event) {
        console.error(`🚨 Error: Missing event name to test. Specify one of: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, ToolFailed, SessionEnd`);
        return;
      }

      try {
        console.log(`\n🧪 Dispatched test trigger for event: ${event}`);
        console.log('-------------------------------------------------------------');
        const res = await fetch(`${getApiBaseUrl()}/api/hooks/test`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event })
        });

        const data = await res.json() as any;
        if (!res.ok) {
          console.error(`❌ Test failed: ${data.error || 'Unknown endpoint error'}`);
          return;
        }

        console.log(`Dispatched Payload Context:`);
        console.log(JSON.stringify(data.payload, null, 2));
        console.log('\nExecution Results:');
        console.log(`  Decision: ${data.result.decision.toUpperCase()}`);
        if (data.result.reason) {
          console.log(`  Reason:   ${data.result.reason}`);
        }
        if (data.result.outputs && data.result.outputs.length > 0) {
          console.log(`  Outputs:`);
          data.result.outputs.forEach((o: any) => {
            console.log(`    - [${o.hookName}] => Decision: ${o.decision.toUpperCase()} Output length: ${o.output?.length || 0}`);
            if (o.error) {
              console.log(`      Error: ${o.error}`);
            }
          });
        }
        console.log('-------------------------------------------------------------');
      } catch (e: any) {
        console.error(`Error testing lifecycle hook: ${e.message}`);
      }
    } else {
      console.error(`🚨 Error: Unknown action "${act}". Expected one of: list, validate, test`);
    }
  });

program.parse(process.argv);
