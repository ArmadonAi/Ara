#!/usr/bin/env bun
import React from 'react';
import { render } from 'ink';
import { Command } from 'commander';
import * as readline from 'readline';

import { ApiClient } from './api/client';
import { loadConfig, saveConfig, setApiBaseUrl, getApiBaseUrl } from './config/manager';
import { TuiApp } from './components/TuiApp';
import { runClawMigration, detectOpenClaw, runHermesMigration, detectHermes } from './claw/migrate';

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
  .version('0.2.0')
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
    try {
      const keys = await client.getConfigKeys();
      const hasSome = keys.GEMINI_API_KEY || keys.OPENAI_API_KEY || keys.ANTHROPIC_API_KEY;
      if (!hasSome) {
        console.warn('\n⚠️  WARNING: No LLM Provider API Keys configured on backend!');
        console.warn('To start querying Ara, please configure your API Keys.');
        console.warn('You can open the Web Dashboard (http://localhost:3000) or write them to the .env file in the workspace root.\n');
      }
    } catch (err) {}

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

          if (userPrompt.startsWith('/')) {
            const parts = userPrompt.slice(1).trim().split(/\s+/);
            const cmd = parts[0]?.toLowerCase() || '';
            const args = parts.slice(1);

            if (cmd === 'agents') {
              const subAction = args[0]?.toLowerCase();
              if (!subAction || subAction === 'list') {
                try {
                  const list = await client.listSubagents();
                  console.log('\n🤖 Available Subagent Profiles:');
                  list.forEach(p => console.log(`- ${p.name}: ${p.description} (${p.model})`));
                  console.log();
                } catch (e) {
                  console.error('Error listing subagents.');
                }
              } else if (subAction === 'show') {
                const name = args[1];
                if (!name) {
                  console.error('Specify agent name: /agents show <name>');
                } else {
                  try {
                    const p = await client.getSubagent(name);
                    console.log(`\n🤖 Agent "${p.name}": ${p.description}\nAllowed Tools: ${p.allowedTools.join(', ')}\n`);
                  } catch (e) {
                    console.error(`Agent "${name}" not found.`);
                  }
                }
              } else {
                console.log('Unknown agents subcommand. Try "/agents list" or "/agents show <name>"');
              }
              continue;
            } else if (cmd === 'delegate') {
              const name = args[0];
              const taskText = args.slice(1).join(' ');
              if (!name || !taskText) {
                console.log('Usage: /delegate <agentName> <task>');
              } else {
                try {
                  console.log(`🚀 Delegating task to subagent "${name}"...`);
                  const run = await client.runSubagent(name, taskText, '', sessId);
                  console.log(`✨ Run ID: ${run.id}. Polling...`);
                  while (true) {
                    const info = await client.getSubagentRun(run.id);
                    if (info.status === 'completed') {
                      console.log(`\n✅ Subagent Completed!\nSummary: ${info.result?.summary}\n`);
                      break;
                    } else if (info.status === 'failed') {
                      console.error(`\n❌ Subagent Run FAILED: ${info.error}\n`);
                      break;
                    } else if (info.status === 'cancelled') {
                      console.warn(`\n⚠️ Subagent Run CANCELLED.\n`);
                      break;
                    }
                    await new Promise(resolve => setTimeout(resolve, 1500));
                  }
                } catch (e: any) {
                  console.error(`Error: ${e.message}`);
                }
              }
              continue;
            } else if (cmd === 'subagent' && args[0] === 'runs') {
              try {
                const runs = await client.listSubagentRuns();
                console.log('\n🤖 Subagent Runs:');
                runs.forEach(r => console.log(`- Run ${r.id} [${r.profileName}]: ${r.status} - "${r.task.slice(0, 30)}..."`));
                console.log();
              } catch (e) {
                console.error('Error fetching runs.');
              }
              continue;
            } else {
              console.log(`Unknown slash command: /${cmd}`);
              continue;
            }
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
  .description('Audit environment, paths, and system health')
  .action(async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const cwd = process.cwd();
    let pass = 0; let fail = 0; let inf = 0;

    const ok = (msg: string) => { pass++; console.log('  ' + msg); };
    const err = (msg: string) => { fail++; console.log('  ' + msg); };
    const info = (msg: string) => { inf++; console.log('  ' + msg); };

    console.log('\n\uD83D\uDD0D Ara Diagnostics Report');
    console.log('=============================================================');
    console.log('  Version:  0.2.0');
    console.log('  Runtime:  Bun ' + process.version);
    console.log('  Platform: ' + process.platform);
    console.log('  CWD:      ' + cwd);
    console.log('-------------------------------------------------------------');

    // ── API reachable ──────────────────────────────────────────
    let apiOnline = false;
    try {
      const stat = await client.getStatus();
      apiOnline = true;
      ok('API server reachable');
      info('  SQLite: ' + (stat.database || 'unknown'));
      info('  Sandbox: ' + (stat.sandboxMode ? 'ENABLED' : 'DISABLED'));
    } catch {
      err('API server not reachable — start with: bun run dev:api');
    }

    // ── .ara directories ───────────────────────────────────────
    const araDirs = ['.ara', '.ara/sessions', '.ara/checkpoints', '.ara/audit', '.ara/skill-learning', '.ara/canvas/workspaces', '.ara/agents', '.ara/locks'];
    for (const d of araDirs) {
      const full = path.join(cwd, d);
      if (fs.existsSync(full)) ok('.ara/' + d.replace('.ara/', '') + ' exists');
      else info('.ara/' + d.replace('.ara/', '') + ' will be created on first boot');
    }

    // ── Config examples ────────────────────────────────────────
    if (fs.existsSync(path.join(cwd, '.ara', 'examples'))) ok('Config examples present');
    else info('Config examples not found (not required)');

    // ── .env ───────────────────────────────────────────────────
    if (fs.existsSync(path.join(cwd, '.env'))) ok('.env file present');
    else info('.env file missing — copy .env.example to .env');

    // ── Critical project files ─────────────────────────────────
    const critical = ['.gitignore', 'bun.lock', 'node_modules', 'package.json', 'tsconfig.json'];
    for (const f of critical) {
      if (fs.existsSync(path.join(cwd, f))) ok(f + ' present');
      else err(f + ' missing');
    }

    // ── Subsystem checks (via API) ────────────────────────────
    if (apiOnline) {
      try {
        const perms = await fetch(getApiBaseUrl() + '/api/permissions/mode');
        if (perms.ok) ok('Permissions subsystem available');
        else info('Permissions endpoint returned status ' + perms.status);
      } catch {
        info('Permissions subsystem check skipped (endpoint not reachable)');
      }

      try {
        const locks = await client.listLocks();
        ok('Locks subsystem available' + (Array.isArray(locks) ? ' (' + locks.length + ' locks)' : ''));
      } catch {
        info('Locks subsystem check skipped (endpoint not available)');
      }

      try {
        const chkpts = await client.listCheckpoints();
        ok('Checkpoints subsystem available' + (Array.isArray(chkpts) ? ' (' + chkpts.length + ' checkpoints)' : ''));
      } catch {
        info('Checkpoints subsystem check skipped (endpoint not available)');
      }
    } else {
      info('Permissions, locks, checkpoints — start API server to verify');
    }

    // ── MCP config check (filesystem) ──────────────────────────
    const mcpConfigPath = path.join(cwd, '.ara', 'mcp.json');
    if (fs.existsSync(mcpConfigPath)) {
      try {
        const raw = fs.readFileSync(mcpConfigPath, 'utf-8');
        JSON.parse(raw);
        ok('MCP config present and valid');
      } catch {
        err('MCP config found but contains invalid JSON — check .ara/mcp.json');
      }
    } else {
      info('MCP config not found — create .ara/mcp.json to use MCP tools');
    }

    // ── GitHub config check (filesystem) ───────────────────────
    const githubConfigPath = path.join(cwd, '.ara', 'github.json');
    if (fs.existsSync(githubConfigPath)) {
      try {
        const raw = fs.readFileSync(githubConfigPath, 'utf-8');
        const cfg = JSON.parse(raw);
        if (cfg.tokenEnv) ok('GitHub config present (token via env: ' + cfg.tokenEnv + ')');
        else info('GitHub config present but tokenEnv not set');
      } catch {
        err('GitHub config found but contains invalid JSON — check .ara/github.json');
      }
    } else {
      info('GitHub config not found — create .ara/github.json to use GitHub tools');
    }

    // ── Path leakage check ──────────────────────────────────────
    try {
      const srcDir = path.join(cwd, 'apps');
      if (fs.existsSync(srcDir)) {
        const { execSync } = require('node:child_process');
        const result = execSync(
          'grep -rn "file:///" apps/ packages/ --include="*.ts" --include="*.tsx" 2>/dev/null || true',
          { cwd, encoding: 'utf-8', maxBuffer: 1024 * 1024 }
        );
        if (result.trim()) {
          const lines = result.trim().split('\n').filter((l: string) => l.length > 0);
          info('Found ' + lines.length + ' file:/// reference(s) in source (verify intentional):');
          for (const line of lines.slice(0, 5)) {
            info('    ' + line.trim());
          }
          if (lines.length > 5) info('    ... and ' + (lines.length - 5) + ' more');
        } else {
          ok('No local path leakage detected');
        }
      } else {
        info('Path leakage check skipped — no apps/ directory');
      }
    } catch {
      info('Path leakage check skipped (grep not available on this platform)');
    }

    // ── Backups directory ──────────────────────────────────────
    const backupsDir = path.join(cwd, '.ara', 'backups');
    if (fs.existsSync(backupsDir)) {
      const entries = fs.readdirSync(backupsDir).length;
      if (entries > 50) info('Backups directory has ' + entries + ' files — consider cleanup');
      else ok('Backups directory healthy (' + entries + ' files)');
    } else {
      info('Backups directory not yet created');
    }

    console.log('-------------------------------------------------------------');
    console.log('  Results:  ' + pass + ' passed, ' + fail + ' failed, ' + inf + ' info');
    console.log('=============================================================\n');
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

// -------------------------------------------------------------
// 24. Command: ara subagents
// -------------------------------------------------------------
const subagentsCmd = program
  .command('subagents')
  .description('Manage safe read-only subagents operations');

subagentsCmd
  .command('list')
  .description('List all available subagent profiles')
  .action(async () => {
    try {
      const list = await client.listSubagents();
      console.log('\n🤖 Available Subagent Profiles:');
      console.log('-------------------------------------------------------------');
      list.forEach(p => {
        console.log(`Name:        ${p.name}`);
        console.log(`Description: ${p.description}`);
        console.log(`Model:       ${p.model}`);
        console.log(`Tools:       ${p.allowedTools.join(', ')}`);
        console.log('-------------------------------------------------------------');
      });
    } catch (e: any) {
      console.error(`Offline Error: Ara API server offline.`);
    }
  });

subagentsCmd
  .command('show <name>')
  .description('Show detailed configurations of a subagent profile')
  .action(async (name) => {
    try {
      const p = await client.getSubagent(name);
      console.log(`\n🤖 Subagent Profile: "${p.name}"`);
      console.log('=============================================================');
      console.log(`Description:  ${p.description}`);
      console.log(`Model:        ${p.model}`);
      console.log(`Permission:   ${p.permissionMode}`);
      console.log(`Allowed Tools:${p.allowedTools.join(', ')}`);
      console.log('------------------------- System Prompt ---------------------');
      console.log(p.systemPrompt);
      console.log('=============================================================');
    } catch (e: any) {
      console.error(`Error: Profile "${name}" not found or API offline.`);
    }
  });

subagentsCmd
  .command('run <name> <task>')
  .description('Delegate a safe read-only task to a subagent and watch execution')
  .option('--context <context>', 'Context or additional reference text')
  .option('--tools <tools>', 'Comma-separated allowed tools override')
  .option('--max-turns <turns>', 'Max execution turns limit', '10')
  .action(async (name, task, options) => {
    try {
      const config = loadConfig();
      const parentSessionId = config.defaultSessionId || 'default-parent';
      const allowedTools = options.tools ? options.tools.split(',').map((t: string) => t.trim()) : undefined;
      const maxTurns = parseInt(options.maxTurns, 10);

      console.log(`🚀 Delegating task to subagent "${name}"...`);
      const run = await client.runSubagent(name, task, options.context, parentSessionId, allowedTools, maxTurns);

      console.log(`✨ Subagent Run started successfully.`);
      console.log(`Run ID:           ${run.id}`);
      console.log(`Child Session ID: ${run.childSessionId}`);
      console.log(`Permission Mode:  ${run.permissionMode}`);
      console.log(`\n⏳ Executing in background, polling status...`);

      // Poll status until complete or failed
      let dotCount = 0;
      while (true) {
        const info = await client.getSubagentRun(run.id);
        if (info.status === 'completed') {
          console.log(`\n\n✅ Subagent Completed!`);
          console.log('============================ RESULT =========================');
          if (info.result) {
            console.log(`Summary: ${info.result.summary}`);
            console.log(`\nFindings (${info.result.findings.length}):`);
            info.result.findings.forEach((f: string, i: number) => console.log(` ${i + 1}. ${f}`));
          } else {
            console.log('Finished with no structured result.');
          }
          console.log('=============================================================');
          break;
        } else if (info.status === 'failed') {
          console.error(`\n\n❌ Subagent Run FAILED: ${info.error || 'Unknown error'}`);
          break;
        } else if (info.status === 'cancelled') {
          console.warn(`\n\n⚠️ Subagent Run CANCELLED.`);
          break;
        }

        dotCount++;
        process.stdout.write(`\rStatus: ${info.status}${''.padEnd(dotCount % 4, '.')}`);
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    } catch (e: any) {
      console.error(`Error delegating task: ${e.message}`);
    }
  });

subagentsCmd
  .command('runs')
  .description('List previous subagent execution runs')
  .action(async () => {
    try {
      const runs = await client.listSubagentRuns();
      console.log('\n🤖 Previous Subagent Runs:');
      console.log('-------------------------------------------------------------');
      runs.forEach(r => {
        const icon = r.status === 'completed' ? '✅' : r.status === 'failed' ? '❌' : r.status === 'cancelled' ? '⚠️' : '⏳';
        console.log(`${icon} Run ID:   ${r.id}`);
        console.log(`  Agent:    ${r.profileName}`);
        console.log(`  Task:     ${r.task.slice(0, 45)}...`);
        console.log(`  Status:   ${r.status}`);
        console.log(`  Created:  ${r.createdAt}`);
        console.log('-------------------------------------------------------------');
      });
    } catch (e: any) {
      console.error(`Error: API server offline.`);
    }
  });

subagentsCmd
  .command('run-info <runId>')
  .description('Get detailed information and results of a subagent run')
  .action(async (runId) => {
    try {
      const r = await client.getSubagentRun(runId);
      const icon = r.status === 'completed' ? '✅' : r.status === 'failed' ? '❌' : r.status === 'cancelled' ? '⚠️' : '⏳';
      console.log(`\n${icon} Subagent Run Details: ${r.id}`);
      console.log('=============================================================');
      console.log(`Agent Profile:    ${r.profileName}`);
      console.log(`Parent Session:   ${r.parentSessionId}`);
      console.log(`Child Session:    ${r.childSessionId}`);
      console.log(`Status:           ${r.status}`);
      console.log(`Task:             ${r.task}`);
      if (r.error) {
        console.log(`Error:            ${r.error}`);
      }
      if (r.result) {
        console.log('-------------------------- Result ---------------------------');
        console.log(`Summary: ${r.result.summary}`);
        console.log(`\nFindings (${r.result.findings.length}):`);
        r.result.findings.forEach((f: string, i: number) => console.log(` ${i + 1}. ${f}`));
      }
      console.log('=============================================================');
    } catch (e: any) {
      console.error(`Error retrieving run details: ${e.message}`);
    }
  });

subagentsCmd
  .command('cancel <runId>')
  .description('Cancel an active running subagent execution')
  .action(async (runId) => {
    try {
      const res = await client.cancelSubagentRun(runId);
      if (res.success) {
        console.log(`✅ Subagent Run ${runId} successfully cancelled.`);
      } else {
        console.error(`❌ Failed: ${res.error || 'Could not cancel run'}`);
      }
    } catch (e: any) {
      console.error(`Error cancelling run: ${e.message}`);
    }
  });

// -------------------------------------------------------------
// 12. Checkpoints & Restore Commands
// -------------------------------------------------------------
program
  .command('checkpoints')
  .description('List recent checkpoints')
  .action(async () => {
    try {
      const list = await client.listCheckpoints();
      if (!list || list.length === 0) {
        console.log('\n🫙 No checkpoints found.\n');
        return;
      }
      console.log('\n🔒 Recent Checkpoints:');
      console.log('=============================================================');
      for (const chk of list) {
        console.log(`📌 ID:        ${chk.id}`);
        console.log(`   Session:   ${chk.sessionId}`);
        console.log(`   Reason:    ${chk.reason}`);
        console.log(`   Created By: ${chk.createdBy}`);
        console.log(`   Time:      ${chk.createdAt}`);
        console.log(`   Files:     ${chk.files?.length || 0} snapshotted`);
        console.log('-------------------------------------------------------------');
      }
      console.log();
    } catch (e: any) {
      console.error(`Error: API server offline.`);
    }
  });

const checkpointCmd = program
  .command('checkpoint')
  .description('Manage checkpoints and workspace states');

checkpointCmd
  .command('create [reason]')
  .description('Create a manual checkpoint for the active session')
  .action(async (reason) => {
    try {
      const config = loadConfig();
      const sessId = config.defaultSessionId;
      if (!sessId) {
        console.error('❌ Error: No default session active. Please run a chat first.');
        return;
      }
      const desc = reason || 'Manual Checkpoint via CLI';
      console.log(`⏳ Spawning checkpoint for session "${sessId}"...`);
      const chk = await client.createCheckpoint(sessId, desc);
      console.log(`\n✅ Checkpoint created successfully!`);
      console.log(`   ID:        ${chk.id}`);
      console.log(`   Reason:    ${chk.reason}`);
      console.log(`   Time:      ${chk.createdAt}\n`);
    } catch (e: any) {
      console.error(`Error creating checkpoint: ${e.message}`);
    }
  });

checkpointCmd
  .command('show <checkpointId>')
  .description('Print detailed metadata of a checkpoint')
  .action(async (checkpointId) => {
    try {
      const chk = await client.getCheckpoint(checkpointId);
      console.log(`\n📌 Checkpoint: ${chk.id}`);
      console.log('=============================================================');
      console.log(`Session ID:      ${chk.sessionId}`);
      console.log(`Created By:      ${chk.createdBy}`);
      console.log(`Created At:      ${chk.createdAt}`);
      console.log(`Reason:          ${chk.reason}`);
      console.log(`Git HEAD Commit: ${chk.gitHead || 'n/a'}`);
      console.log(`Message Count:   ${chk.messageCount}`);
      console.log(`Snapshotted:     ${chk.files?.length || 0} files`);
      console.log('=============================================================');
      console.log();
    } catch (e: any) {
      console.error(`Error: Checkpoint "${checkpointId}" not found or API offline.`);
    }
  });

checkpointCmd
  .command('diff <checkpointId>')
  .description('Show file changes relative to the checkpoint state')
  .action(async (checkpointId) => {
    try {
      const diff = await client.diffCheckpoint(checkpointId);
      console.log(`\n🔍 Checkpoint Diff relative to current workspace state: ${checkpointId}`);
      console.log('=============================================================');
      
      const modified = diff.modified || [];
      const created = diff.created || [];
      const deleted = diff.deleted || [];
      const skipped = diff.skipped || [];

      if (modified.length === 0 && created.length === 0 && deleted.length === 0) {
        console.log('✨ Workspace is identical to checkpoint state.');
      } else {
        if (created.length > 0) {
          console.log('\n➕ Created Files:');
          created.forEach((f: string) => console.log(`  [+] ${f}`));
        }
        if (modified.length > 0) {
          console.log('\n~ Modified Files:');
          modified.forEach((f: string) => console.log(`  [~] ${f}`));
        }
        if (deleted.length > 0) {
          console.log('\n➖ Deleted Files:');
          deleted.forEach((f: string) => console.log(`  [-] ${f}`));
        }
      }
      
      if (skipped.length > 0) {
        console.log(`\n. Skipped (Large/Binary/Secrets): ${skipped.length} files`);
      }
      console.log('\n=============================================================');
      console.log();
    } catch (e: any) {
      console.error(`Error: Checkpoint "${checkpointId}" not found or API offline.`);
    }
  });

program
  .command('restore <checkpointId>')
  .description('Restore code files and/or session history to checkpoint state')
  .option('--mode <mode>', 'Restore mode: code_only, conversation_only, or both', 'code_only')
  .action(async (checkpointId, options) => {
    const mode = options.mode || 'code_only';
    if (!['code_only', 'conversation_only', 'both'].includes(mode)) {
      console.error('❌ Error: Invalid mode. Choose from: code_only, conversation_only, both');
      return;
    }
    
    try {
      console.log(`⏳ Restoring to checkpoint "${checkpointId}" in mode "${mode}"...`);
      const result = await client.restoreCheckpoint(checkpointId, mode as any);
      console.log(`\n✅ Restore successful!`);
      if (result.restoredFiles && result.restoredFiles.length > 0) {
        console.log(`   Restored Files (${result.restoredFiles.length}):`);
        result.restoredFiles.forEach((f: string) => console.log(`     - ${f}`));
      }
      if (result.messageCount !== undefined) {
        console.log(`   Conversation rewound to ${result.messageCount} messages.`);
      }
      console.log();
    } catch (e: any) {
      console.error(`Error executing restore: ${e.message}`);
    }
  });

program
  .command('rewind')
  .description('Print recent checkpoints and provide restore instructions')
  .action(async () => {
    try {
      const list = await client.listCheckpoints();
      if (!list || list.length === 0) {
        console.log('\n🫙 No checkpoints available to rewind.\n');
        return;
      }
      console.log('\n⏪ Rewind / Rollback Helper:');
      console.log('=============================================================');
      console.log('To rewind to a checkpoint, execute the corresponding command below:\n');
      for (const chk of list.slice(0, 10)) {
        console.log(`📌 Checkpoint ID: ${chk.id}`);
        console.log(`   Reason:        ${chk.reason}`);
        console.log(`   Created At:    ${chk.createdAt}`);
        console.log(`   Restore Commands:`);
        console.log(`     >  ara restore ${chk.id} --mode code_only          (Restore workspace files only)`);
        console.log(`     >  ara restore ${chk.id} --mode conversation_only  (Rewind chat messages only)`);
        console.log(`     >  ara restore ${chk.id} --mode both               (Restore both files & chat)`);
        console.log('-------------------------------------------------------------');
      }
      console.log();
    } catch (e: any) {
      console.error(`Error: API server offline.`);
    }
  });

// -------------------------------------------------------------
// MCP / External Tools Commands
// -------------------------------------------------------------
const mcp = program.command('mcp').description('Manage MCP external tool servers');

mcp
  .command('servers')
  .description('List all configured MCP servers')
  .action(async () => {
    try {
      const data = await client.listMcpServers();
      const servers = data.servers || [];
      console.log('\n🔌 MCP Servers:');
      console.log('=============================================================');
      if (servers.length === 0) {
        console.log('  No MCP servers configured.\n');
        return;
      }
      for (const s of servers) {
        const status = s.enabled ? '🟢 enabled' : '🔴 disabled';
        const trust = s.trusted ? 'trusted' : 'untrusted';
        console.log(`  ${s.id.padEnd(16)} ${status.padEnd(12)} ${trust.padEnd(12)} mode:${s.permissionMode || 'default'} type:${s.type}`);
      }
      console.log();
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
    }
  });

mcp
  .command('server <id>')
  .description('Show details for a specific MCP server')
  .action(async (id: string) => {
    try {
      const s = await client.getMcpServer(id);
      console.log(`\n🔌 MCP Server: ${s.name} (${s.id})`);
      console.log('=============================================================');
      console.log(`  State:            ${s.state}`);
      console.log(`  Type:             ${s.type}`);
      console.log(`  Enabled:          ${s.enabled ? 'Yes' : 'No'}`);
      console.log(`  Trusted:          ${s.trusted ? 'Yes' : 'No'}`);
      console.log(`  Permission Mode:  ${s.permissionMode || 'default'}`);
      console.log(`  Tools Discovered: ${(s.tools || []).length}`);
      console.log(`  Last Error:       ${s.lastError || 'none'}`);
      console.log(`  Last Checked:     ${s.lastCheckedAt || 'never'}`);
      if (s.tools && s.tools.length > 0) {
        console.log(`\n  Discovered Tools:`);
        for (const t of s.tools) {
          const mut = t.mutating ? '⚠️ ' : '   ';
          console.log(`    ${mut}${t.name.padEnd(20)} ${t.dangerLevel} ${t.description ? `- ${t.description}` : ''}`);
        }
      }
      console.log();
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
    }
  });

mcp
  .command('start <id>')
  .description('Start an MCP server')
  .action(async (id: string) => {
    try {
      console.log(`Starting MCP server "${id}"...`);
      const result = await client.startMcpServer(id);
      if (result.ok) {
        console.log(`✅ Server "${id}" started. ${(result.tools || []).length} tools discovered.`);
      } else {
        console.error(`❌ Failed: ${result.error}`);
      }
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
    }
  });

mcp
  .command('stop <id>')
  .description('Stop an MCP server')
  .action(async (id: string) => {
    try {
      console.log(`Stopping MCP server "${id}"...`);
      const result = await client.stopMcpServer(id);
      if (result.ok) {
        console.log(`✅ Server "${id}" stopped.`);
      } else {
        console.error(`❌ Failed: ${result.error}`);
      }
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
    }
  });

mcp
  .command('restart <id>')
  .description('Restart an MCP server')
  .action(async (id: string) => {
    try {
      console.log(`Restarting MCP server "${id}"...`);
      const result = await client.restartMcpServer(id);
      if (result.ok) {
        console.log(`✅ Server "${id}" restarted. ${(result.tools || []).length} tools discovered.`);
      } else {
        console.error(`❌ Failed: ${result.error}`);
      }
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
    }
  });

mcp
  .command('reconnect <id>')
  .description('Reconnect a failed MCP server (stop + restart with fresh client)')
  .action(async (id: string) => {
    try {
      console.log(`Reconnecting MCP server "${id}"...`);
      const result = await client.reconnectMcpServer(id);
      if (result.ok) {
        console.log(`✅ Server "${id}" reconnected. ${(result.tools || []).length} tools discovered.`);
      } else {
        console.error(`❌ Failed: ${result.error}`);
      }
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
    }
  });

mcp
  .command('tools [serverId]')
  .description('List all discovered MCP tools. Optionally filter by server ID.')
  .action(async (serverId: string | undefined) => {
    try {
      const data = await client.listMcpTools(serverId);
      const tools = data.tools || [];
      console.log(`\n🔧 MCP Tools${serverId ? ` for server "${serverId}"` : ''}:`);
      console.log('=============================================================');
      if (tools.length === 0) {
        console.log('  No tools discovered.\n');
        return;
      }
      for (const t of tools) {
        const fullName = t.fullName || `mcp.${t.serverId}.${t.name}`;
        const mut = t.mutating ? '⚠️ ' : '   ';
        console.log(`  ${mut}${fullName}`);
        console.log(`       danger: ${t.dangerLevel}  desc: ${t.description || 'no description'}`);
      }
      console.log(`\n  Total: ${tools.length} tools\n`);
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
    }
  });

mcp
  .command('call <fullToolName>')
  .description('Call an MCP tool through the safety pipeline. Use --json for input.')
  .option('--json <input>', 'JSON input for the tool call')
  .option('--session <sessionId>', 'Session ID (default: cli-mcp-call)')
  .action(async (fullToolName: string, options: { json?: string; session?: string }) => {
    try {
      let input: Record<string, unknown> = {};
      if (options.json) {
        try {
          input = JSON.parse(options.json);
        } catch {
          console.error('❌ Error: --json must be valid JSON');
          return;
        }
      }
      const sessionId = options.session || 'cli-mcp-call';
      console.log(`🔧 Calling MCP tool "${fullToolName}"...`);
      const result = await client.callMcpTool(fullToolName, input, sessionId);
      if (result.awaitingApproval) {
        console.log(`\n🛡️  This tool requires manual approval.`);
        console.log(`   ${result.error}`);
        console.log(`   Use 'ara approve <id>' to authorize after the request appears.\n`);
      } else if (result.ok) {
        console.log(`\n✅ Tool call succeeded:`);
        console.log(result.output || '(no output)');
        console.log();
      } else {
        console.error(`\n❌ Tool call failed: ${result.error || result.error || 'Unknown error'}`);
        console.log();
      }
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
    }
  });

mcp
  .command('refresh [serverId]')
  .description('Refresh tools for a specific server or all running servers. Omit serverId to refresh all.')
  .action(async (serverId: string | undefined) => {
    try {
      if (serverId) {
        console.log(`🔄 Refreshing tools for server "${serverId}"...`);
        const result = await client.refreshMcpTools(serverId);
        if (result.ok) {
          console.log(`✅ Server "${serverId}" refreshed. ${result.tools.length} tools available.`);
          if (result.removed && result.removed.length > 0) {
            console.log(`   Removed tools: ${result.removed.join(', ')}`);
          }
        } else {
          console.error(`❌ Failed: ${result.error}`);
        }
      } else {
        console.log('🔄 Refreshing tools for all running servers...');
        const result = await client.refreshMcpTools();
        const ok = (result.results || []).filter((r: any) => r.ok);
        const fail = (result.results || []).filter((r: any) => !r.ok);
        console.log(`   ${ok.length} servers refreshed, ${fail.length} failed.`);
        for (const r of ok) {
          console.log(`   ✅ ${r.serverId}: ${r.toolCount} tools`);
        }
        for (const r of fail) {
          console.log(`   ❌ ${r.serverId}: ${r.error}`);
        }
      }
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
    }
  });

mcp
  .command('health')
  .description('Check MCP server health')
  .action(async () => {
    try {
      const data = await client.getMcpHealth();
      const results = data.results || [];
      console.log('\n💓 MCP Health:');
      console.log('=============================================================');
      if (results.length === 0) {
        console.log('  No servers running.\n');
        return;
      }
      for (const r of results) {
        console.log(`  ${r.serverId.padEnd(16)} state: ${r.state.padEnd(12)} tools: ${r.toolCount}  error: ${r.lastError || 'none'}`);
      }
      console.log();
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
    }
  });

mcp
  .command('validate')
  .description('Validate MCP config format from a JSON string')
  .argument('<config>', 'JSON string of MCP config')
  .action(async (config: string) => {
    try {
      const parsed = JSON.parse(config);
      const result = await client.validateMcpConfig(parsed);
      if (result.valid) {
        console.log('✅ MCP config is valid.');
      } else {
        console.error(`❌ MCP config invalid: ${result.error}`);
      }
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
    }
  });

// -------------------------------------------------------------
// GitHub Integration Commands
// -------------------------------------------------------------
const gh = program.command('github').description('GitHub integration commands');

gh
  .command('status')
  .description('Show GitHub integration status')
  .action(async () => {
    try {
      const s = await client.getGitHubStatus();
      console.log('\n🔗 GitHub Integration:');
      console.log('=============================================================');
      console.log(`  Enabled:        ${s.configured ? 'Yes' : 'No'}`);
      console.log(`  Token Present:  ${s.tokenPresent ? 'Yes' : 'No'}`);
      console.log(`  Read-Only:      ${s.readOnly ? 'Yes' : 'No'}`);
      console.log(`  Default Repo:   ${s.defaultOwner || '?'}/${s.defaultRepo || '?'}`);
      console.log(`  Allowed Repos:  ${s.allowedRepos?.join(', ') || 'all'}`);
      console.log(`  Permission:     ${s.permissionMode}`);
      console.log();
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
    }
  });

gh
  .command('repo [ownerRepo]')
  .description('Show repository info. Format: owner/repo (default from config)')
  .action(async (ownerRepo: string | undefined) => {
    try {
      const s = await client.getGitHubStatus();
      const [owner, repo] = (ownerRepo || `${s.defaultOwner}/${s.defaultRepo}`).split('/');
      if (!owner || !repo) { console.error('Usage: ara github repo owner/repo'); return; }
      const data = await client.getGitHubRepo(owner, repo);
      if (data.ok) console.log(`\n📦 ${data.output}\n`);
      else console.log(`\n${data.output || data.error}\n`);
    } catch (e: any) { console.error(`Error: ${e.message}`); }
  });

gh
  .command('issues [ownerRepo]')
  .description('List open issues. Format: owner/repo')
  .option('--page <n>', 'Page number', parseInt, 1)
  .option('--per-page <n>', 'Results per page (1-100)', parseInt, 30)
  .action(async (ownerRepo: string | undefined, opts: { page?: number; perPage?: number }) => {
    try {
      const s = await client.getGitHubStatus();
      const [owner, repo] = (ownerRepo || `${s.defaultOwner}/${s.defaultRepo}`).split('/');
      if (!owner || !repo) { console.error('Usage: ara github issues owner/repo'); return; }
      const page = Math.max(opts?.page || 1, 1);
      const perPage = Math.min(Math.max(opts?.perPage || 30, 1), 100);
      const data = await client.getGitHubIssues(owner, repo, page, perPage);
      if (data.ok) console.log(`\n📋 Issues for ${owner}/${repo}:\n${data.output}\n`);
      else console.log(`\n${data.error}\n`);
    } catch (e: any) { console.error(`Error: ${e.message}`); }
  });

gh
  .command('issue <number> [ownerRepo]')
  .description('Show issue details')
  .action(async (number: string, ownerRepo: string | undefined) => {
    try {
      const s = await client.getGitHubStatus();
      const [owner, repo] = (ownerRepo || `${s.defaultOwner}/${s.defaultRepo}`).split('/');
      const data = await client.getGitHubIssue(owner, repo, parseInt(number));
      if (data.ok) console.log(`\n📋 Issue #${number}:\n${data.output}\n`);
      else console.log(`\n${data.error}\n`);
    } catch (e: any) { console.error(`Error: ${e.message}`); }
  });

gh
  .command('prs [ownerRepo]')
  .description('List open pull requests')
  .option('--page <n>', 'Page number', parseInt, 1)
  .option('--per-page <n>', 'Results per page (1-100)', parseInt, 30)
  .action(async (ownerRepo: string | undefined, opts: { page?: number; perPage?: number }) => {
    try {
      const s = await client.getGitHubStatus();
      const [owner, repo] = (ownerRepo || `${s.defaultOwner}/${s.defaultRepo}`).split('/');
      const page = Math.max(opts?.page || 1, 1);
      const perPage = Math.min(Math.max(opts?.perPage || 30, 1), 100);
      const data = await client.getGitHubPRs(owner, repo, page, perPage);
      if (data.ok) console.log(`\n🔄 PRs for ${owner}/${repo}:\n${data.output}\n`);
      else console.log(`\n${data.error}\n`);
    } catch (e: any) { console.error(`Error: ${e.message}`); }
  });

gh
  .command('pr <number> [ownerRepo]')
  .description('Show pull request details')
  .action(async (number: string, ownerRepo: string | undefined) => {
    try {
      const s = await client.getGitHubStatus();
      const [owner, repo] = (ownerRepo || `${s.defaultOwner}/${s.defaultRepo}`).split('/');
      const data = await client.getGitHubPR(owner, repo, parseInt(number));
      if (data.ok) console.log(`\n🔄 PR #${number}:\n${data.output}\n`);
      else console.log(`\n${data.error}\n`);
    } catch (e: any) { console.error(`Error: ${e.message}`); }
  });

gh
  .command('checks <ref> [ownerRepo]')
  .description('List check runs for a Git ref (branch, commit SHA)')
  .option('--page <n>', 'Page number', parseInt, 1)
  .option('--per-page <n>', 'Results per page (1-100)', parseInt, 30)
  .action(async (ref: string, ownerRepo: string | undefined, opts: { page?: number; perPage?: number }) => {
    try {
      const s = await client.getGitHubStatus();
      const [owner, repo] = (ownerRepo || `${s.defaultOwner}/${s.defaultRepo}`).split('/');
      const page = Math.max(opts?.page || 1, 1);
      const perPage = Math.min(Math.max(opts?.perPage || 30, 1), 100);
      const data = await client.getGitHubChecks(owner, repo, ref, page, perPage);
      if (data.ok) console.log(`\n✅ Check runs for ${ref}:\n${data.output}\n`);
      else console.log(`\n${data.error}\n`);
    } catch (e: any) { console.error(`Error: ${e.message}`); }
  });

gh
  .command('runs [ownerRepo]')
  .description('List workflow runs')
  .option('--page <n>', 'Page number', parseInt, 1)
  .option('--per-page <n>', 'Results per page (1-100)', parseInt, 30)
  .action(async (ownerRepo: string | undefined, opts: { page?: number; perPage?: number }) => {
    try {
      const s = await client.getGitHubStatus();
      const [owner, repo] = (ownerRepo || `${s.defaultOwner}/${s.defaultRepo}`).split('/');
      const page = Math.max(opts?.page || 1, 1);
      const perPage = Math.min(Math.max(opts?.perPage || 30, 1), 100);
      const data = await client.getGitHubWorkflowRuns(owner, repo, page, perPage);
      if (data.ok) console.log(`\n🏃 Workflow runs for ${owner}/${repo}:\n${data.output}\n`);
      else console.log(`\n${data.error}\n`);
    } catch (e: any) { console.error(`Error: ${e.message}`); }
  });

// ── GitHub Write Commands (require approval) ───────────────────────

gh
  .command('issue-create')
  .description('Create a new issue')
  .requiredOption('--title <title>', 'Issue title')
  .option('--body <body>', 'Issue body')
  .option('--labels <labels>', 'Comma-separated labels')
  .option('--owner-repo <owner/repo>', 'Repository (default from config)')
  .action(async (opts: { title: string; body?: string; labels?: string; ownerRepo?: string }) => {
    try {
      const s = await client.getGitHubStatus();
      const [owner, repo] = (opts.ownerRepo || `${s.defaultOwner}/${s.defaultRepo}`).split('/');
      if (!owner || !repo) { console.error('Usage: ara github issue-create --title "..." [--owner-repo owner/repo]'); return; }
      const labels = opts.labels ? opts.labels.split(',').map(l => l.trim()) : undefined;
      const data = await client.createGitHubIssue(owner, repo, opts.title, opts.body, labels);
      if (data.awaitingApproval) {
        console.log('\n🛡️  This action requires manual approval.');
        console.log(`   ${data.error}\n`);
      } else if (data.ok) {
        console.log(`\n✅ Issue created: ${data.output?.slice(0, 200)}\n`);
      } else {
        console.error(`\n❌ ${data.error}\n`);
      }
    } catch (e: any) { console.error(`Error: ${e.message}`); }
  });

gh
  .command('issue-comment <number>')
  .description('Comment on an issue')
  .requiredOption('--body <body>', 'Comment body')
  .option('--owner-repo <owner/repo>', 'Repository (default from config)')
  .action(async (number: string, opts: { body: string; ownerRepo?: string }) => {
    try {
      const s = await client.getGitHubStatus();
      const [owner, repo] = (opts.ownerRepo || `${s.defaultOwner}/${s.defaultRepo}`).split('/');
      const data = await client.commentGitHubIssue(owner, repo, parseInt(number), opts.body);
      if (data.awaitingApproval) {
        console.log('\n🛡️  This action requires manual approval.');
        console.log(`   ${data.error}\n`);
      } else if (data.ok) {
        console.log(`\n✅ Comment posted on issue #${number}\n`);
      } else {
        console.error(`\n❌ ${data.error}\n`);
      }
    } catch (e: any) { console.error(`Error: ${e.message}`); }
  });

gh
  .command('pr-review <number>')
  .description('Review a pull request')
  .requiredOption('--body <body>', 'Review body')
  .option('--event <event>', 'Event: APPROVE, REQUEST_CHANGES, COMMENT (default: COMMENT)')
  .option('--owner-repo <owner/repo>', 'Repository (default from config)')
  .action(async (number: string, opts: { body: string; event?: string; ownerRepo?: string }) => {
    try {
      const s = await client.getGitHubStatus();
      const [owner, repo] = (opts.ownerRepo || `${s.defaultOwner}/${s.defaultRepo}`).split('/');
      const data = await client.createGitHubPRReview(owner, repo, parseInt(number), opts.body, opts.event);
      if (data.awaitingApproval) {
        console.log('\n🛡️  This action requires manual approval.');
        console.log(`   ${data.error}\n`);
      } else if (data.ok) {
        console.log(`\n✅ Review posted on PR #${number}\n`);
      } else {
        console.error(`\n❌ ${data.error}\n`);
      }
    } catch (e: any) { console.error(`Error: ${e.message}`); }
  });


// -------------------------------------------------------------
// Lock Commands
// -------------------------------------------------------------
// -------------------------------------------------------------
// Lock Commands
// -------------------------------------------------------------
const locks = program.command('locks').description('File lock management');

locks
  .command('acquire <path>')
  .description('Acquire a file lock')
  .option('--mode <mode>', 'Lock mode: read or write', 'read')
  .option('--ttl <ms>', 'Time-to-live in milliseconds', parseInt)
  .action(async (filePath: string, opts: { mode?: string; ttl?: number }) => {
    try {
      const mode = opts.mode === 'write' ? 'write' : 'read';
      const result = await client.acquireLock(filePath, mode, 'cli', opts.ttl);
      if (result.ok) {
        console.log('\n\U0001f517 Lock acquired:', result.lock?.id, '(' + mode + ')');
        console.log('   Path:', filePath);
        console.log('   Expires:', result.lock?.expiresAt, '\n');
      } else if (result.conflict) {
        console.log('\n\u26a0\ufe0f  Lock conflict:', result.error, '\n');
      } else {
        console.error('\n\u274c', result.error, '\n');
      }
    } catch (e: any) { console.error('Error:', e.message); }
  });

locks
  .command('release <lockId>')
  .description('Release a lock')
  .action(async (lockId: string) => {
    try {
      const result = await client.releaseLock(lockId);
      if (result.ok) console.log('\n\U0001f513 Lock released:', lockId, '\n');
      else console.error('\n\u274c', result.error, '\n');
    } catch (e: any) { console.error('Error:', e.message); }
  });

locks
  .command('force-release <lockId>')
  .description('Force-release a lock (requires reason)')
  .requiredOption('--reason <reason>', 'Reason for force release')
  .action(async (lockId: string, opts: { reason: string }) => {
    try {
      const result = await client.forceReleaseLock(lockId, opts.reason);
      if (result.ok) console.log('\n\U0001f513 Lock force-released:', lockId, '\n');
      else console.error('\n\u274c', result.error, '\n');
    } catch (e: any) { console.error('Error:', e.message); }
  });

locks
  .command('list')
  .description('List active locks')
  .option('--status <status>', 'Filter by status (active, released, expired)')
  .action(async (opts: { status?: string }) => {
    try {
      const data = await client.listLocks(opts.status);
      const items = data.locks || [];
      console.log('\n\U0001f517 Active Locks:', items.length);
      for (const l of items) {
        console.log('  ' + l.id + '  ' + l.mode.padEnd(6) + '  ' + l.path + '  owner:' + (l.agentName || l.sessionId) + '  expires:' + (l.expiresAt || '').slice(11, 19));
      }
      console.log();
    } catch (e: any) { console.error('Error:', e.message); }
  });

locks
  .command('cleanup')
  .description('Clean up expired locks')
  .action(async () => {
    try {
      const result = await client.cleanupLocks();
      console.log('\n\U0001f9f9 Expired locks cleaned:', result.cleaned || 0, '\n');
    } catch (e: any) { console.error('Error:', e.message); }
  });

locks
  .command('audit')
  .description('View lock audit log')
  .option('--limit <n>', 'Number of records', parseInt, 20)
  .action(async (opts: { limit?: number }) => {
    try {
      const data = await client.getLockAudit(opts.limit);
      const records = data.records || [];
      console.log('\n\U0001f4cb Lock Audit (' + records.length + ' records):');
      for (const r of records.slice(0, opts.limit || 20)) {
        console.log('  [' + (r.event || '').padEnd(22) + '] ' + (r.path || r.lockId || '') + '  ' + (r.sessionId || ''));
      }
      console.log();
    } catch (e: any) { console.error('Error:', e.message); }
  });

// -------------------------------------------------------------
// Parallel Subagent Commands
// -------------------------------------------------------------
const para = program.command('subagents-parallel').description('Parallel subagent management');

para
  .command('run <agents> <task>')
  .description('Run subagents in parallel. Agents: comma-separated profile names')
  .option('--concurrency <n>', 'Max concurrent agents', parseInt, 3)
  .action(async (agents: string, task: string, opts: { concurrency?: number }) => {
    try {
      const profiles = agents.split(',').map((a: string) => a.trim());
      const s = await client.getGitHubStatus();
      console.log('\n\U0001f680 Starting parallel run with', profiles.length, 'agents...');
      const result = await client.startParallelRun(profiles, s.config?.sessionId || 'cli', opts.concurrency);
      console.log('   Run ID:', result.id);
      console.log('   Status:', result.status);
      console.log('   Check status: ara subagents-parallel-run ' + result.id + '\n');
    } catch (e: any) { console.error('Error:', e.message); }
  });

para
  .command('runs')
  .description('List parallel subagent runs')
  .action(async () => {
    try {
      const data = await client.listParallelRuns();
      const runs = data.runs || [];
      console.log('\n\U0001f504 Parallel Runs:', runs.length);
      for (const r of runs) {
        console.log('  ' + r.id + '  status:' + r.status + '  profiles:' + (r.profiles || []).length + '  results:' + (r.results || []).length);
      }
      console.log();
    } catch (e: any) { console.error('Error:', e.message); }
  });

para
  .command('run-info <id>')
  .description('Get parallel run details')
  .action(async (id: string) => {
    try {
      const r = await client.getParallelRun(id);
      console.log('\n\U0001f504 Parallel Run:', r.id);
      console.log('   Status:', r.status);
      console.log('   Profiles:', (r.profiles || []).map((p: any) => p.name).join(', '));
      console.log('   Max Concurrency:', r.maxConcurrency);
      for (const res of (r.results || [])) {
        console.log('   Result: ' + res.profileName + '  status:' + res.status + '  ' + (res.summary?.slice(0, 80) || ''));
      }
      console.log();
    } catch (e: any) { console.error('Error:', e.message); }
  });

para
  .command('cancel <id>')
  .description('Cancel a parallel run')
  .action(async (id: string) => {
    try {
      const result = await client.cancelParallelRun(id);
      if (result.ok) console.log('\n\u2705 Parallel run cancelled:', id, '\n');
      else console.error('\n\u274c', result.error, '\n');
    } catch (e: any) { console.error('Error:', e.message); }
  });

// -------------------------------------------------------------
// Canvas Workspace Commands
// -------------------------------------------------------------
const canvas = program.command('canvas').description('Canvas workspace management');

canvas
  .command('list')
  .description('List canvas workspaces')
  .action(async () => {
    try {
      const data = await client.listCanvasWorkspaces();
      const workspaces = data.workspaces || [];
      console.log('\n\uD83D\uDCD1 Canvas Workspaces:', workspaces.length);
      if (workspaces.length === 0) { console.log('  No workspaces. Create one: ara canvas create "My Workspace"\n'); return; }
      for (const ws of workspaces) {
        console.log('  ' + ws.id.slice(0, 12).padEnd(14) + '  ' + (ws.name || '').padEnd(24) + '  ' + (ws.createdAt || '').slice(0, 10));
      }
      console.log();
    } catch (e: any) { console.error('Error:', e.message); }
  });

canvas
  .command('create <name>')
  .description('Create a new canvas workspace')
  .option('--description <desc>', 'Workspace description')
  .action(async (name: string, opts: { description?: string }) => {
    try {
      const result = await client.createCanvasWorkspace(name, opts.description);
      console.log('\n\u2705 Workspace created:', result.id);
      console.log('   Name:', result.name);
      console.log('   Show: ara canvas show ' + result.id + '\n');
    } catch (e: any) { console.error('Error:', e.message); }
  });

canvas
  .command('show <workspaceId>')
  .description('Show workspace details with nodes and edges')
  .action(async (workspaceId: string) => {
    try {
      const data = await client.getCanvasWorkspace(workspaceId);
      if (data.error) { console.error('Error:', data.error); return; }
      const ws = data.workspace || {};
      const nodes = data.nodes || [];
      const edges = data.edges || [];
      console.log('\n\uD83D\uDCD1 Workspace:', ws.name);
      console.log('   ID:', ws.id);
      console.log('   Description:', ws.description || '(none)');
      console.log('   Created:', (ws.createdAt || '').slice(0, 10));
      console.log('   Updated:', (ws.updatedAt || '').slice(0, 10));
      // Node counts by type
      const byType: Record<string, number> = {};
      for (const n of nodes) byType[n.type] = (byType[n.type] || 0) + 1;
      console.log('\n   Nodes:', nodes.length);
      for (const [t, c] of Object.entries(byType)) {
        console.log('     ' + t + ': ' + c);
      }
      console.log('   Edges:', edges.length);
      // Recent nodes
      if (nodes.length > 0) {
        console.log('\n   Recent Nodes:');
        for (const n of nodes.slice(-5).reverse()) {
          console.log('     ' + n.id.slice(0, 10) + '  ' + (n.type || '').padEnd(16) + '  ' + (n.title || '').slice(0, 40));
        }
      }
      console.log('   Export: ara canvas export ' + ws.id + '\n');
    } catch (e: any) { console.error('Error:', e.message); }
  });

canvas
  .command('delete <workspaceId>')
  .description('Delete a canvas workspace')
  .action(async (workspaceId: string) => {
    try {
      const result = await client.deleteCanvasWorkspace(workspaceId);
      if (result.ok) console.log('\n\u2705 Workspace deleted:', workspaceId, '\n');
      else console.error('\n\u274c', result.error, '\n');
    } catch (e: any) { console.error('Error:', e.message); }
  });

canvas
  .command('add-node <workspaceId>')
  .description('Add a node to a canvas workspace')
  .requiredOption('--type <type>', 'Node type: chat, file, memory, skill, github_issue, github_pr, mcp_tool, note, ...')
  .requiredOption('--title <title>', 'Node title')
  .option('--ref <ref>', 'Source reference')
  .option('--x <x>', 'X position', parseInt, 0)
  .option('--y <y>', 'Y position', parseInt, 0)
  .option('--description <desc>', 'Node description')
  .action(async (workspaceId: string, opts: { type: string; title: string; ref?: string; x?: number; y?: number; description?: string }) => {
    const validTypes = ['chat', 'session', 'task', 'file', 'artifact', 'memory', 'skill', 'subagent', 'github_issue', 'github_pr', 'mcp_tool', 'checkpoint', 'note'];
    if (!validTypes.includes(opts.type)) {
      console.error('\n\u274c Invalid node type: "' + opts.type + '". Valid types: ' + validTypes.join(', ') + '\n');
      return;
    }
    try {
      const result = await client.addCanvasNode(workspaceId, {
        type: opts.type, title: opts.title, sourceRef: opts.ref,
        position: { x: opts.x || 0, y: opts.y || 0 },
        description: opts.description,
      });
      console.log('\n\u2705 Node added:', result.id, '(' + opts.type + ')', '\n');
    } catch (e: any) { console.error('Error:', e.message); }
  });

canvas
  .command('update-node <workspaceId> <nodeId>')
  .description('Update a canvas node')
  .option('--title <title>', 'New title')
  .option('--description <desc>', 'New description')
  .action(async (workspaceId: string, nodeId: string, opts: { title?: string; description?: string }) => {
    try {
      const patch: any = {};
      if (opts.title) patch.title = opts.title;
      if (opts.description) patch.description = opts.description;
      const result = await client.updateCanvasNode(workspaceId, nodeId, patch);
      console.log('\n\u2705 Node updated:', nodeId, '\n');
    } catch (e: any) { console.error('Error:', e.message); }
  });

canvas
  .command('delete-node <workspaceId> <nodeId>')
  .description('Delete a canvas node')
  .action(async (workspaceId: string, nodeId: string) => {
    try {
      const result = await client.deleteCanvasNode(workspaceId, nodeId);
      if (result.ok) console.log('\n\u2705 Node deleted:', nodeId, '\n');
      else console.error('\n\u274c', result.error, '\n');
    } catch (e: any) { console.error('Error:', e.message); }
  });

canvas
  .command('add-edge <workspaceId> <fromNodeId> <toNodeId>')
  .description('Add an edge between two nodes')
  .option('--type <type>', 'Edge type: reference, dependency, result, action, context', 'reference')
  .option('--label <label>', 'Edge label')
  .action(async (workspaceId: string, fromNodeId: string, toNodeId: string, opts: { type?: string; label?: string }) => {
    const validEdgeTypes = ['reference', 'dependency', 'result', 'action', 'context'];
    if (opts.type && !validEdgeTypes.includes(opts.type)) {
      console.error('\n\u274c Invalid edge type: "' + opts.type + '". Valid types: ' + validEdgeTypes.join(', ') + '\n');
      return;
    }
    try {
      const result = await client.addCanvasEdge(workspaceId, {
        fromNodeId, toNodeId, type: opts.type || 'reference', label: opts.label,
      });
      console.log('\n\u2705 Edge added:', result.id, '\n');
    } catch (e: any) { console.error('Error:', e.message); }
  });

canvas
  .command('delete-edge <workspaceId> <edgeId>')
  .description('Delete a canvas edge')
  .action(async (workspaceId: string, edgeId: string) => {
    try {
      const result = await client.deleteCanvasEdge(workspaceId, edgeId);
      if (result.ok) console.log('\n\u2705 Edge deleted:', edgeId, '\n');
      else console.error('\n\u274c', result.error, '\n');
    } catch (e: any) { console.error('Error:', e.message); }
  });

canvas
  .command('export <workspaceId>')
  .description('Export a canvas workspace as JSON')
  .option('--out <file>', 'Output file path')
  .action(async (workspaceId: string, opts: { out?: string }) => {
    try {
      const data = await client.exportCanvasWorkspace(workspaceId);
      const json = JSON.stringify(data, null, 2);
      if (opts.out) {
        const fs = await import('node:fs/promises');
        await fs.writeFile(opts.out, json, 'utf-8');
        console.log('\n\u2705 Exported to:', opts.out, '\n');
      } else {
        console.log(json);
      }
    } catch (e: any) { console.error('Error:', e.message); }
  });


// -------------------------------------------------------------
// Skill Learning Commands
// -------------------------------------------------------------
const skills = program.command('skills').description('Skill learning and management');

skills
  .command('suggest')
  .description('Detect repeated workflows and suggest new skills')
  .action(async () => {
    try {
      const overview = await client.getSkillLearningOverview();
      console.log('\n Learning Loop Overview:');
      console.log('   Workflow fingerprints:', overview.workflowCount || 0);
      console.log('   Repeated (>=3):', overview.repeatedCount || 0);
      console.log('   Drafts:', overview.draftCount || 0);
      console.log('\n   Check drafts: ara skills drafts\n');
    } catch (e: any) { console.error('Error:', e.message); }
  });

skills
  .command('workflows')
  .description('List repeated workflow fingerprints')
  .option('--threshold <n>', 'Minimum repeat count', parseInt, 3)
  .action(async (opts: { threshold?: number }) => {
    try {
      const data = await client.getSkillLearningWorkflows(opts.threshold);
      const workflows = data.workflows || [];
      console.log('\n Workflow Fingerprints:', workflows.length);
      if (workflows.length === 0) { console.log('  No repeated workflows found.\n'); return; }
      for (const w of workflows) {
        console.log('  [' + w.count + 'x] ' + (w.normalizedGoal || '').slice(0, 60));
        console.log('       Tools: ' + (w.toolSequence || []).join(', '));
      }
      console.log();
    } catch (e: any) { console.error('Error:', e.message); }
  });

skills
  .command('drafts')
  .description('List skill drafts')
  .action(async () => {
    try {
      const data = await client.listSkillDrafts();
      const drafts = data.drafts || [];
      console.log('\n Skill Drafts:', drafts.length);
      if (drafts.length === 0) { console.log('  No drafts. Run ara skills suggest to detect workflows.\n'); return; }
      for (const d of drafts) {
        console.log('  ' + (d.id || '').slice(0, 14).padEnd(16) + ' ' + (d.status || '').padEnd(12) + ' ' + (d.proposedSkillName || '').slice(0, 24).padEnd(26) + ' ' + Math.round((d.confidence || 0) * 100) + '%');
      }
      console.log();
    } catch (e: any) { console.error('Error:', e.message); }
  });

skills
  .command('draft <draftId>')
  .description('Show skill draft details')
  .action(async (draftId: string) => {
    try {
      const d = await client.getSkillDraft(draftId);
      if (d.error) { console.error('Error:', d.error); return; }
      console.log('\n Draft:', d.id);
      console.log('   Title:', d.title);
      console.log('   Skill:', d.proposedSkillName);
      console.log('   Status:', d.status);
      console.log('   Confidence:', Math.round((d.confidence || 0) * 100) + '%');
      console.log('   Redaction warnings:', (d.redactionWarnings || []).join(', ') || 'none');
      if (d.body) {
        console.log('\n--- Body ---');
        console.log(d.body.slice(0, 500));
        console.log('---');
      }
      console.log('\n   Approve: ara skills approve ' + d.id);
      console.log('   Reject:  ara skills reject ' + d.id);
      console.log('   Diff:    ara skills diff ' + d.id + '\n');
    } catch (e: any) { console.error('Error:', e.message); }
  });

skills
  .command('approve <draftId>')
  .description('Approve a skill draft and write SKILL.md')
  .action(async (draftId: string) => {
    try {
      console.log('Approving draft ' + draftId + '...');
      const result = await client.approveSkillDraft(draftId);
      if (result.ok) {
        console.log('\n Skill created/updated:', result.skillName);
        console.log('   Version:', result.version);
        console.log('   Type:', result.isNew ? 'New skill' : 'Version update');
        console.log('   Written to: skills/' + result.skillName + '/SKILL.md\n');
      } else {
        console.error('\n Failed:', result.error, '\n');
      }
    } catch (e: any) { console.error('Error:', e.message); }
  });

skills
  .command('reject <draftId>')
  .description('Reject a skill draft')
  .action(async (draftId: string) => {
    try {
      const result = await client.rejectSkillDraft(draftId);
      if (result.ok) console.log('\n Draft rejected:', draftId, '\n');
      else console.error('\n Failed:', result.error, '\n');
    } catch (e: any) { console.error('Error:', e.message); }
  });

skills
  .command('diff <draftId>')
  .description('Compare a draft with the existing skill')
  .action(async (draftId: string) => {
    try {
      const result = await client.diffSkillDraft(draftId);
      if (result.error) { console.error('Error:', result.error); return; }
      console.log('\n Draft Diff:');
      console.log('   Existing skill:', result.existingSkill ? 'Yes' : 'No');
      if (result.newContent) {
        console.log('\n--- Proposed content ---');
        console.log(result.newContent.slice(0, 500));
        console.log('---');
      }
      console.log();
    } catch (e: any) { console.error('Error:', e.message); }
  });


skills
  .command('analyze-session <sessionId>')
  .description('Analyze a session transcript to detect workflow patterns')
  .action(async (sessionId: string) => {
    try {
      console.log('Analyzing session ' + sessionId + '... (requires entries via API)');
      console.log('Use POST /api/skill-learning/analyze/session/' + sessionId + ' with entries array\n');
    } catch (e: any) { console.error('Error:', e.message); }
  });

skills
  .command('analyze-recent')
  .description('Analyze recent sessions to detect workflow patterns')
  .option('--limit <n>', 'Number of sessions', parseInt, 10)
  .action(async (opts: { limit?: number }) => {
    try {
      console.log('Analyzing up to ' + (opts.limit || 10) + ' recent sessions...');
      console.log('Use POST /api/skill-learning/analyze/recent with sessions array\n');
    } catch (e: any) { console.error('Error:', e.message); }
  });
skills
  .command('stats')
  .description('Show skill usage statistics')
  .action(async () => {
    try {
      const data = await client.getSkillLearningStats();
      const stats = data.stats || [];
      console.log('\n Skill Usage Stats:', stats.length);
      if (stats.length === 0) { console.log('  No usage data recorded.\n'); return; }
      for (const s of stats) {
        console.log('  ' + (s.skillName || '').padEnd(24) + ' uses:' + (s.useCount || 0) + ' success:' + (s.successCount || 0) + ' fail:' + (s.failureCount || 0) + ' last:' + (s.lastUsedAt || '').slice(0, 10));
      }
      console.log();
    } catch (e: any) { console.error('Error:', e.message); }
  });

// -------------------------------------------------------------
// Onboarding Setup Command
// -------------------------------------------------------------
program
  .command('setup')
  .description('Interactive first-time onboarding and configuration setup wizard')
  .action(async () => {
    console.log('\n🌟 Welcome to Ara: Personal AI Control Plane Onboarding Wizard! 🌟\n');
    
    // 1. Detect OpenClaw
    const hasOpenClaw = await detectOpenClaw();
    if (hasOpenClaw) {
      console.log('🔍 Detected an existing OpenClaw setup in ~/.openclaw!');
      const ans = await askUser('Would you like to migrate settings, memories, skills, and keys from OpenClaw? (y/N): ');
      if (ans.toLowerCase().trim() === 'y' || ans.toLowerCase().trim() === 'yes') {
        console.log('\n🚀 Starting migration from OpenClaw...');
        const summary = await runClawMigration({ preset: 'full', overwrite: true });
        console.log('✅ Migration complete!');
        console.log(`   - Keys migrated: ${summary.keysMigrated.length > 0 ? summary.keysMigrated.join(', ') : 'None'}`);
        console.log(`   - Settings migrated: ${Object.keys(summary.settingsMigrated).length}`);
        console.log(`   - Memories migrated: ${summary.memoriesMigratedCount} facts`);
        console.log(`   - Skills migrated: ${summary.skillsMigratedCount}`);
        if (summary.warnings.length > 0) {
          console.log('\n⚠️ Warnings:');
          summary.warnings.forEach(w => console.log(`   - ${w}`));
        }
        console.log();
      } else {
        console.log('Skipping OpenClaw migration.\n');
      }
    }

    // 1.5. Detect Hermes
    const hasHermes = await detectHermes();
    if (hasHermes) {
      console.log('🔍 Detected an existing Hermes setup in ~/.hermes!');
      const ans = await askUser('Would you like to migrate settings, memories, skills, and keys from Hermes? (y/N): ');
      if (ans.toLowerCase().trim() === 'y' || ans.toLowerCase().trim() === 'yes') {
        console.log('\n🚀 Starting migration from Hermes...');
        const summary = await runHermesMigration({ preset: 'full', overwrite: true });
        console.log('✅ Migration complete!');
        console.log(`   - Keys migrated: ${summary.keysMigrated.length > 0 ? summary.keysMigrated.join(', ') : 'None'}`);
        console.log(`   - Settings migrated: ${Object.keys(summary.settingsMigrated).length}`);
        console.log(`   - Memories migrated: ${summary.memoriesMigratedCount} facts`);
        console.log(`   - Skills migrated: ${summary.skillsMigratedCount}`);
        if (summary.warnings.length > 0) {
          console.log('\n⚠️ Warnings:');
          summary.warnings.forEach(w => console.log(`   - ${w}`));
        }
        console.log();
      } else {
        console.log('Skipping Hermes migration.\n');
      }
    }

    // 2. Guide standard Ara configuration setup
    console.log('🔧 Standard Ara Configuration Setup:');
    const modelAns = await askUser('Configure default LLM model (e.g. Gemini, OpenAI, Anthropic) [Gemini]: ');
    const model = modelAns.trim() || 'Gemini';

    const apiAns = await askUser('Configure API server base URL [http://localhost:3001]: ');
    const apiBase = apiAns.trim() || 'http://localhost:3001';

    const config = loadConfig();
    config.defaultModel = model;
    config.apiBaseUrl = apiBase;
    saveConfig(config);

    console.log('\n🎉 Onboarding setup complete! To start the Control Plane:');
    console.log('   1. Start the API server:   bun run dev:api');
    console.log('   2. Start the CLI / TUI:     ara\n');
  });

// -------------------------------------------------------------
// OpenClaw Migration Commands
// -------------------------------------------------------------
const claw = program.command('claw').alias('openclaw').description('OpenClaw migration and integration utility');

claw
  .command('migrate')
  .description('Migrate settings, memories, skills, and keys from OpenClaw')
  .option('--dry-run', 'Preview what would be migrated without copying anything')
  .option('--preset <type>', 'Presets: "full" (all including secrets) or "user-data" (settings, memories, skills only)', 'full')
  .option('--overwrite', 'Overwrite existing keys, settings, memory items, or skills if they conflict')
  .action(async (opts: { dryRun?: boolean; preset?: string; overwrite?: boolean }) => {
    const isDry = !!opts.dryRun;
    const isOverwrite = !!opts.overwrite;
    const preset = opts.preset === 'user-data' ? 'user-data' : 'full';

    console.log(`\n🛸 Ara OpenClaw Migration Loop [Preset: ${preset}]`);
    if (isDry) console.log('🛡️  DRY-RUN MODE ACTIVE: No files or configs will be modified.\n');
    else console.log('⚙️  Migrating configurations and assets...\n');

    try {
      const summary = await runClawMigration({
        dryRun: isDry,
        preset,
        overwrite: isOverwrite
      });

      if (!summary.detected) {
        console.error('❌ Error: OpenClaw setup folder (~/.openclaw) was not detected.');
        console.error('Make sure OpenClaw is installed and configured at ~/.openclaw\n');
        return;
      }

      console.log('📈 Migration Summary:');
      console.log('-------------------------------------------------------------');
      
      console.log(`🔑 Keys Migrated:   ${summary.keysMigrated.length}`);
      if (summary.keysMigrated.length > 0) {
        summary.keysMigrated.forEach(k => console.log(`   - ${k}`));
      }
      
      console.log(`⚙️  Settings Map:     ${Object.keys(summary.settingsMigrated).length} keys`);
      if (Object.keys(summary.settingsMigrated).length > 0) {
        for (const [k, v] of Object.entries(summary.settingsMigrated)) {
          console.log(`   - ${k} => ${v}`);
        }
      }

      console.log(`🧠 Memories Facts:  ${summary.memoriesMigratedCount} items appended`);
      console.log(`🧬 Skills Copied:   ${summary.skillsMigratedCount} folders`);
      
      if (summary.warnings.length > 0) {
        console.log('\n⚠️ Warnings / Skipped Actions:');
        summary.warnings.forEach(w => console.log(`   - ${w}`));
      }

      console.log('-------------------------------------------------------------');
      if (isDry) {
        console.log('✅ Dry-run preview completed successfully.\n');
      } else {
        console.log('🎉 Migration finished successfully!\n');
      }
    } catch (err: any) {
      console.error(`❌ Migration failed: ${err.message}\n`);
    }
  });

// -------------------------------------------------------------
// Hermes Migration Commands
// -------------------------------------------------------------
const hermesCmd = program.command('hermes').description('Hermes migration and integration utility');

hermesCmd
  .command('migrate')
  .description('Migrate settings, memories, skills, and keys from Hermes')
  .option('--dry-run', 'Preview what would be migrated without copying anything')
  .option('--preset <type>', 'Presets: "full" (all including secrets) or "user-data" (settings, memories, skills only)', 'full')
  .option('--overwrite', 'Overwrite existing keys, settings, memory items, or skills if they conflict')
  .action(async (opts: { dryRun?: boolean; preset?: string; overwrite?: boolean }) => {
    const isDry = !!opts.dryRun;
    const isOverwrite = !!opts.overwrite;
    const preset = opts.preset === 'user-data' ? 'user-data' : 'full';

    console.log(`\n🛸 Ara Hermes Migration Loop [Preset: ${preset}]`);
    if (isDry) console.log('🛡️  DRY-RUN MODE ACTIVE: No files or configs will be modified.\n');
    else console.log('⚙️  Migrating configurations and assets...\n');

    try {
      const summary = await runHermesMigration({
        dryRun: isDry,
        preset,
        overwrite: isOverwrite
      });

      if (!summary.detected) {
        console.error('❌ Error: Hermes setup folder (~/.hermes) was not detected.');
        console.error('Make sure Hermes is installed and configured at ~/.hermes\n');
        return;
      }

      console.log('📈 Migration Summary:');
      console.log('-------------------------------------------------------------');
      
      console.log(`🔑 Keys Migrated:   ${summary.keysMigrated.length}`);
      if (summary.keysMigrated.length > 0) {
        summary.keysMigrated.forEach(k => console.log(`   - ${k}`));
      }
      
      console.log(`⚙️  Settings Map:     ${Object.keys(summary.settingsMigrated).length} keys`);
      if (Object.keys(summary.settingsMigrated).length > 0) {
        for (const [k, v] of Object.entries(summary.settingsMigrated)) {
          console.log(`   - ${k} => ${v}`);
        }
      }

      console.log(`🧠 Memories Facts:  ${summary.memoriesMigratedCount} items appended`);
      console.log(`🧬 Skills Copied:   ${summary.skillsMigratedCount} folders`);
      
      if (summary.warnings.length > 0) {
        console.log('\n⚠️ Warnings / Skipped Actions:');
        summary.warnings.forEach(w => console.log(`   - ${w}`));
      }

      console.log('-------------------------------------------------------------');
      if (isDry) {
        console.log('✅ Dry-run preview completed successfully.\n');
      } else {
        console.log('🎉 Migration finished successfully!\n');
      }
    } catch (err: any) {
      console.error(`❌ Migration failed: ${err.message}\n`);
    }
  });


// -------------------------------------------------------------
// Maintenance Commands
// -------------------------------------------------------------
program
  .command('maintenance')
  .description('System maintenance tasks (JSONL compaction, stats)')
  .action(() => {
    console.log('\nUsage: ara maintenance <command>\n');
    console.log('  ara maintenance compact     Compact JSONL audit files');
    console.log('  ara maintenance stats       Show JSONL file sizes\n');
  });

program
  .command('maintenance compact')
  .description('Compact JSONL audit files — keep only recent entries')
  .option('--keep <n>', 'Number of recent entries to keep', parseInt, 1000)
  .option('--dir <path>', 'Specific JSONL directory to compact')
  .action(async (opts: { keep?: number; dir?: string }) => {
    const fs = require('node:fs');
    const path = require('node:path');
    const { compactJSONL, compactJSONLDir, getJSONLDirStats, getJSONLSize } = require('./packages/tools/src/maintenance.ts');
    const cwd = process.cwd();
    const keep = Math.max(opts.keep || 1000, 100);
    let totalRemoved = 0;

    const dirs = opts.dir ? [opts.dir] : [
      path.join(cwd, '.ara', 'sessions'),
      path.join(cwd, '.ara', 'audit'),
      path.join(cwd, '.ara', 'skill-learning'),
    ];

    console.log('\nCompacting JSONL files (keeping last ' + keep + ' entries per file)...\n');

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) { console.log('  ~ ' + dir + ' (not found)'); continue; }
      const stats = getJSONLDirStats(dir);
      if (stats.files === 0) { console.log('  ~ ' + dir + ' (no JSONL files)'); continue; }
      console.log('  ' + dir + ': ' + stats.files + ' files, ' + (stats.totalBytes / 1024).toFixed(1) + ' KB, ' + stats.totalLines + ' lines');

      if (opts.dir) {
        // Single directory mode — compact each file
        const r = compactJSONLDir(dir, keep);
        for (const [file, result] of Object.entries(r.results)) {
          if (result.removedLines > 0) {
            console.log('    ' + file + ': removed ' + result.removedLines + ' lines');
            totalRemoved += result.removedLines;
          }
        }
      } else {
        // Smart mode — compact specific known files
        const knownFiles = [
          path.join(dir, '..', 'audit', 'mcp.jsonl'),
          path.join(dir, '..', 'audit', 'locks.jsonl'),
        ];
        for (const fp of knownFiles) {
          if (fs.existsSync(fp)) {
            const r = compactJSONL(fp, keep);
            if (r.removedLines > 0) {
              console.log('    ' + path.basename(fp) + ': removed ' + r.removedLines + ' lines (' + r.originalLines + ' -> ' + r.keptLines + ')');
              totalRemoved += r.removedLines;
            }
          }
        }
        // Compact session transcripts
        const r = compactJSONLDir(dir, keep);
        for (const [file, result] of Object.entries(r.results)) {
          if (result.removedLines > 0) {
            console.log('    ' + file + ': removed ' + result.removedLines + ' lines (' + result.originalLines + ' -> ' + result.keptLines + ')');
            totalRemoved += result.removedLines;
          }
        }
      }
    }

    console.log('\nDone. Removed ' + totalRemoved + ' lines total.\n');
  });

program
  .command('maintenance stats')
  .description('Show JSONL file storage statistics')
  .action(async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const { getJSONLDirStats, getJSONLSize } = require('./packages/tools/src/maintenance.ts');
    const cwd = process.cwd();

    const targets: { name: string; dir: string }[] = [
      { name: 'Session transcripts', dir: path.join(cwd, '.ara', 'sessions') },
      { name: 'Audit logs', dir: path.join(cwd, '.ara', 'audit') },
      { name: 'Skill learning', dir: path.join(cwd, '.ara', 'skill-learning') },
      { name: 'Canvas workspaces', dir: path.join(cwd, '.ara', 'canvas', 'workspaces') },
      { name: 'Skill drafts', dir: path.join(cwd, '.ara', 'skill-drafts') },
    ];

    let totalBytes = 0;
    let totalFiles = 0;
    let totalLines = 0;

    console.log('\nJSONL Storage Statistics:\n');

    for (const t of targets) {
      if (!fs.existsSync(t.dir)) { console.log('  ' + t.name.padEnd(25) + ' (empty)'); continue; }
      const stats = getJSONLDirStats(t.dir);
      if (stats.files === 0) {
        // Check if there are non-JSONL files
        const files = fs.readdirSync(t.dir).filter((f: string) => !f.endsWith('.jsonl'));
        console.log('  ' + t.name.padEnd(25) + ' ' + files.length + ' files (non-JSONL)');
        continue;
      }
      const sizeKB = (stats.totalBytes / 1024).toFixed(1);
      console.log('  ' + t.name.padEnd(25) + ' ' + stats.files + ' files, ' + sizeKB + ' KB, ' + stats.totalLines + ' lines');
      totalBytes += stats.totalBytes;
      totalFiles += stats.files;
      totalLines += stats.totalLines;
    }

    console.log('\n  Total: ' + totalFiles + ' files, ' + (totalBytes / 1024).toFixed(1) + ' KB, ' + totalLines + ' lines\n');
  });

program.parse(process.argv);
