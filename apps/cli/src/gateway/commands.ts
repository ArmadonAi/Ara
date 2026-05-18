import { Command } from 'commander';
import { ApiClient } from '../api/client';

const client = new ApiClient();

export function createGatewayCommand(): Command {
  const gateway = new Command('gateway')
    .description('Manage messaging gateway channels (Telegram, LINE, etc.)');

  // ── ara gateway status ──────────────────────────────────────
  gateway
    .command('status')
    .description('Show gateway channel statuses')
    .action(async () => {
      try {
        const data = await client.getGatewayStatus();
        const channels = data.channels || [];
        console.log('\n  Gateway Channels');
        console.log('  ' + '─'.repeat(50));
        if (channels.length === 0) {
          console.log('  No channels registered.\n');
          return;
        }
        for (const ch of channels) {
          const icon = ch.running ? '●' : '○';
          const health = ch.healthy ? 'healthy' : 'unhealthy';
          console.log(`  ${icon} ${ch.name.padEnd(12)} ${health}  ${ch.running ? 'running' : 'stopped'}`);
          if (ch.info && Object.keys(ch.info).length > 0) {
            for (const [k, v] of Object.entries(ch.info)) {
              console.log(`     ${k}: ${v}`);
            }
          }
        }
        console.log('  ' + '─'.repeat(50));
        console.log(`  ${channels.length} channel(s)\n`);
      } catch (e: any) {
        console.error(`\n  Error: ${e.message}\n`);
      }
    });

  // ── ara gateway restart <name> ──────────────────────────────
  gateway
    .command('restart <name>')
    .description('Restart a gateway channel')
    .action(async (name: string) => {
      try {
        console.log(`\n  Restarting channel "${name}"...`);
        const result = await client.restartGatewayChannel(name);
        console.log(`  ${result.ok ? 'Restarted.' : 'Failed.'}\n`);
      } catch (e: any) {
        console.error(`\n  Error: ${e.message}\n`);
      }
    });

  // ── ara gateway stop <name> ─────────────────────────────────
  gateway
    .command('stop <name>')
    .description('Stop a gateway channel')
    .action(async (name: string) => {
      try {
        console.log(`\n  Stopping channel "${name}"...`);
        const result = await client.stopGatewayChannel(name);
        console.log(`  ${result.ok ? 'Stopped.' : 'Failed.'}\n`);
      } catch (e: any) {
        console.error(`\n  Error: ${e.message}\n`);
      }
    });

  return gateway;
}
