import { Command } from 'commander';
import { ApiClient } from '../api/client';

const client = new ApiClient();

export function createCodexCommand(): Command {
  const codex = new Command('codex')
    .description('Manage Codex/Claude Code coding agent sessions');

  // ── ara codex start ─────────────────────────────────────────
  codex
    .command('start [prompt]')
    .description('Start a new coding agent session')
    .option('-b, --binary <name>', 'Binary to use (codex, claude)')
    .action(async (prompt: string | undefined, options: { binary?: string }) => {
      try {
        console.log('\n  Starting coding agent session...');
        const result = await client.startCodex(options.binary, prompt);
        console.log(`  Session started: ${result.id}`);
        console.log(`  Binary: ${result.binary}`);
        console.log(`  Status: ${result.status}`);
        console.log(`\n  Use: ara codex send ${result.id} <input>`);
        console.log(`  Use: ara codex output ${result.id}`);
        console.log(`  Use: ara codex stop ${result.id}\n`);
      } catch (e: any) {
        console.error(`\n  Error: ${e.message}\n`);
      }
    });

  // ── ara codex send ──────────────────────────────────────────
  codex
    .command('send <id> <input>')
    .description('Send input to a coding agent session')
    .action(async (id: string, input: string) => {
      try {
        await client.sendCodex(id, input);
        console.log('  Sent.');
      } catch (e: any) {
        console.error(`  Error: ${e.message}`);
      }
    });

  // ── ara codex output ────────────────────────────────────────
  codex
    .command('output <id>')
    .description('Show accumulated output from a session')
    .option('-f, --follow', 'Follow new output (poll every 1s)')
    .action(async (id: string, options: { follow?: boolean }) => {
      try {
        const result = await client.getCodexOutput(id);
        console.log(`\n  Session: ${id} (${result.status})`);
        console.log('  ' + '─'.repeat(50));
        console.log(`  ${result.output || '(no output yet)'}`);
        console.log('  ' + '─'.repeat(50));
        console.log('');

        if (options.follow) {
          console.log('  Watching for new output... Press Ctrl+C to stop.\n');
          const poll = setInterval(async () => {
            try {
              const r = await client.getCodexOutput(id);
              if (r.output !== result.output) {
                console.log(r.output.slice(result.output.length));
              }
              if (r.status !== 'running') {
                console.log(`\n  Session ${r.status}.\n`);
                clearInterval(poll);
              }
            } catch {}
          }, 1000);
          // Keep process alive
          process.on('SIGINT', () => { clearInterval(poll); process.exit(0); });
        }
      } catch (e: any) {
        console.error(`  Error: ${e.message}`);
      }
    });

  // ── ara codex stop ──────────────────────────────────────────
  codex
    .command('stop <id>')
    .description('Stop a coding agent session')
    .action(async (id: string) => {
      try {
        await client.stopCodex(id);
        console.log(`  Session ${id} stopped.`);
      } catch (e: any) {
        console.error(`  Error: ${e.message}`);
      }
    });

  // ── ara codex sessions ──────────────────────────────────────
  codex
    .command('sessions')
    .description('List all coding agent sessions')
    .action(async () => {
      try {
        const sessions = await client.listCodexSessions();
        console.log('\n  Codex Sessions');
        console.log('  ' + '─'.repeat(50));
        if (sessions.length === 0) {
          console.log('  No sessions.\n');
          return;
        }
        for (const s of sessions) {
          const icon = s.status === 'running' ? '●' : '○';
          console.log(`  ${icon} ${s.id.slice(-20).padEnd(22)} ${s.status.padEnd(10)} ${s.binary}`);
        }
        console.log('  ' + '─'.repeat(50));
        console.log(`  ${sessions.length} session(s)\n`);
      } catch (e: any) {
        console.error(`\n  Error: ${e.message}\n`);
      }
    });

  return codex;
}
