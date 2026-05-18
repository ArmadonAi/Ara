import { Command } from 'commander';
import {
  ServerTarget, ServerConfig, ServerStatus,
  startProcess, stopProcess, stopAll,
  readPidFile, readServerJson, writeServerJson,
  buildServerStatus, formatUptime,
  isRunning, isPortInUse, checkHealth,
  tailLogs, redactSecrets, cleanupStalePids,
  ensureDirs, getLogPath, getLogSizeBytes, formatBytes,
  pruneLogs, cleanServerState,
  loadServerConfig, saveServerConfig, configSource,
  startWatchdog, stopWatchdog, watchdogState,
  installService, uninstallService, getServiceStatus,
  detectPlatform,
  SERVER_DIR,
} from './processManager';

// ─── Helpers ────────────────────────────────────────────────────────

async function printStatus(): Promise<void> {
  const json = readServerJson();
  const targets: ServerTarget[] = ['api', 'web', 'worker'];

  console.log('\n  Ara Server Runtime Status');
  console.log('  ' + '─'.repeat(58));

  if (!json) {
    console.log('  No server state found. Server has not been started.');
    console.log('  Start with:  ara server start [--with-web]\n');
    return;
  }

  for (const target of targets) {
    const state = json.processes[target];
    if (!state) continue;

    const pid = readPidFile(target);
    const actuallyRunning = pid !== null && isRunning(pid);
    const health = actuallyRunning ? await checkHealth(target) : 'unknown';
    const icon = actuallyRunning ? '●' : '○';
    const runningSince = actuallyRunning && state.pid === pid ? json.startedAt : undefined;
    const uptime = runningSince ? formatUptime(runningSince) : '-';
    const logSize = formatBytes(json.logSizes?.[target] ?? getLogSizeBytes(target));

    if (target === 'api') {
      const port = state.port || 3001;
      const url = state.url || `http://localhost:${port}`;
      console.log(`  ${icon} API     pid=${pid || '-'} port=${port} ${url}`);
      console.log(`     health=${health} uptime=${uptime} logs=${logSize}`);
    } else if (target === 'web') {
      const port = state.port || 5173;
      const url = state.url || `http://localhost:${port}`;
      console.log(`  ${icon} Web     pid=${pid || '-'} port=${port} ${url}`);
      console.log(`     health=${health} uptime=${uptime} logs=${logSize}`);
    } else if (target === 'worker') {
      console.log(`  ${icon} Worker  pid=${pid || '-'}`);
      console.log(`     health=${health} uptime=${uptime} logs=${logSize}`);
    }

    if (state.lastError) {
      console.log(`     lastError=${state.lastError}`);
    }
  }

  console.log('  ' + '─'.repeat(58));
  console.log(`  Started:    ${json.startedAt ? new Date(json.startedAt).toLocaleString() : '-'}`);
  console.log(`  Uptime:     ${formatUptime(json.startedAt)}`);
  console.log(`  Restarts:   ${json.restartCount ?? 0}`);
  if (json.lastCrash) console.log(`  Last crash: ${new Date(json.lastCrash).toLocaleString()}`);
  console.log(`  Watchdog:   ${json.watchdogEnabled ? 'on' : 'off'}`);
  console.log(`  Config:     ${json.configSource || configSource()}`);
  console.log(`  State dir:  ${SERVER_DIR}`);

  // Show system service status
  const svc = getServiceStatus();
  const svcIcon = svc.installed ? (svc.running ? '●' : '○') : '─';
  const svcLabel = svc.installed ? `${svc.name} (${svc.type})` : 'not installed';
  console.log(`  Service:    ${svcIcon} ${svcLabel}`);
  console.log('');
}

// ─── Commands ───────────────────────────────────────────────────────

export function createServerCommand(): Command {
  const server = new Command('server')
    .description('Manage the local Ara runtime (API, Web, Worker)');

  // ── ara server (default: status) ──────────────────────────────
  server
    .command('status', { isDefault: true })
    .description('Show server runtime status with uptime, restarts, log sizes')
    .action(async () => {
      await printStatus();
    });

  // ── ara server start ──────────────────────────────────────────
  server
    .command('start')
    .description('Start Ara server processes')
    .option('--api-only', 'Start only the API server')
    .option('--with-web', 'Start the Web UI server')
    .option('--with-worker', 'Start the background worker (default: true)')
    .option('--api-port <port>', 'API server port', '3001')
    .option('--web-port <port>', 'Web UI dev server port', '5173')
    .option('--detached', 'Run in background (default)', true)
    .option('--foreground', 'Run in foreground with logs streamed')
    .option('--watchdog', 'Enable auto-restart watchdog for crashed processes')
    .action(async (options) => {
      const apiPort = parseInt(options.apiPort, 10);
      const webPort = parseInt(options.webPort, 10);
      const foreground = !!options.foreground;
      const apiOnly = !!options.apiOnly;
      const withWeb = !!options.withWeb;
      const withWorker = options.withWorker !== false;
      const watchdog = !!options.watchdog;

      // Save config if flags provided
      const config: ServerConfig = {
        ...loadServerConfig(),
        apiPort,
        webPort,
        withWeb,
        withWorker,
        watchdogEnabled: watchdog,
      };
      saveServerConfig(config);

      ensureDirs();
      console.log('');
      console.log('  Starting Ara Runtime...');

      const stale = cleanupStalePids();
      if (stale.cleaned.length > 0) {
        console.log(`  Cleaned stale PID files: ${stale.cleaned.join(', ')}`);
      }

      // API
      const apiInUse = await isPortInUse(apiPort);
      if (apiInUse) {
        const existingPid = readPidFile('api');
        if (existingPid && isRunning(existingPid)) {
          console.log(`  API already running on port ${apiPort} (pid ${existingPid})`);
        } else {
          console.error(`  ERROR: Port ${apiPort} is in use by another process.`);
          console.error(`  Choose a different port with --api-port <port>`);
          return;
        }
      } else {
        console.log(`  Starting API on port ${apiPort}...`);
        const info = startProcess('api', { apiPort, foreground });
        if (!info) { console.error('  ERROR: Failed to start API server'); return; }
        console.log(`  API started (pid ${info.pid})`);
      }

      // Worker
      if (!apiOnly && withWorker) {
        const workerPid = readPidFile('worker');
        if (workerPid && isRunning(workerPid)) {
          console.log(`  Worker already running (pid ${workerPid})`);
        } else {
          console.log('  Starting Worker...');
          const info = startProcess('worker', { foreground });
          if (info) console.log(`  Worker started (pid ${info.pid})`);
          else console.error('  WARNING: Failed to start Worker (non-fatal)');
        }
      }

      // Web
      if (withWeb) {
        const webPid = readPidFile('web');
        if (webPid && isRunning(webPid)) {
          console.log(`  Web already running on port ${webPort} (pid ${webPid})`);
        } else {
          const webInUse = await isPortInUse(webPort);
          if (webInUse) {
            console.error(`  ERROR: Port ${webPort} is in use by another process.`);
          } else {
            console.log(`  Starting Web on port ${webPort}...`);
            const info = startProcess('web', { webPort, foreground });
            if (info) console.log(`  Web started (pid ${info.pid})`);
            else console.error('  WARNING: Failed to start Web UI (non-fatal)');
          }
        }
      }

      // Write state
      const existing = readServerJson();
      const apiPid = readPidFile('api') || existing?.processes.api.pid;
      const webPid = readPidFile('web') || existing?.processes.web.pid;
      const workerPid = readPidFile('worker') || existing?.processes.worker.pid;
      const prevRestartCount = existing?.restartCount ?? 0;
      const prevLastCrash = existing?.lastCrash;
      const status = buildServerStatus(
        apiPort, webPort,
        apiPid ?? undefined, webPid ?? undefined, workerPid ?? undefined,
        prevRestartCount, prevLastCrash, watchdog
      );
      writeServerJson(status);

      // Start watchdog if requested
      if (watchdog) {
        console.log('  Starting watchdog (auto-restart on crash)...');
        startWatchdog((target, attempt) => {
          console.log(`  [watchdog] Restarted ${target} (attempt ${attempt})`);
        });
      }

      const mode = foreground ? 'foreground' : 'detached';
      console.log(`\n  Ara Runtime started in ${mode} mode.`);
      console.log(`  Watchdog: ${watchdog ? 'enabled' : 'disabled'}`);
      if (foreground) {
        console.log('  Streaming logs... Press Ctrl+C to stop all.');
      } else {
        console.log('  Use:  ara server status  to check status');
        console.log('  Use:  ara server logs   to view logs');
        console.log('  Use:  ara server stop   to stop');
      }
      console.log('');
    });

  // ── ara server stop ───────────────────────────────────────────
  server
    .command('stop [target]')
    .description('Stop server processes (api, web, worker, or all)')
    .action(async (target) => {
      // Stop watchdog first
      stopWatchdog();

      console.log('');
      if (target && ['api', 'web', 'worker'].includes(target)) {
        const t = target as ServerTarget;
        console.log(`  Stopping ${t}...`);
        const result = await stopProcess(t);
        if (result.ok) console.log(`  ${t} stopped.`);
        else console.error(`  Error stopping ${t}: ${result.error || 'unknown'}`);
      } else {
        console.log('  Stopping all processes...');
        const result = await stopAll();
        const count = Object.values(result.results).filter(r => r.ok).length;
        console.log(`  ${count}/3 processes stopped.`);
        console.log('');
      }
    });

  // ── ara server restart ────────────────────────────────────────
  server
    .command('restart')
    .description('Restart all server processes')
    .option('--with-web', 'Start Web UI after restart')
    .option('--api-port <port>', 'API server port', '3001')
    .option('--web-port <port>', 'Web UI dev server port', '5173')
    .option('--foreground', 'Run in foreground')
    .option('--watchdog', 'Enable auto-restart watchdog')
    .action(async (options) => {
      console.log('\n  Restarting Ara Runtime...\n');
      stopWatchdog();
      await stopAll();
      const startCmd = server.commands.find(c => c.name() === 'start');
      if (startCmd) {
        await startCmd.parseAsync(['node', 'ara', 'start', ...process.argv.slice(3)], { from: 'user' });
      }
    });

  // ── ara server logs ───────────────────────────────────────────
  server
    .command('logs')
    .description('Show server process logs')
    .option('--api', 'Show API logs only')
    .option('--web', 'Show Web logs only')
    .option('--worker', 'Show Worker logs only')
    .option('--lines <n>', 'Number of lines to show', '50')
    .option('--follow, -f', 'Follow log output (live tail)')
    .action(async (options) => {
      const lines = parseInt(options.lines, 10) || 50;
      const showApi = options.api || (!options.web && !options.worker);
      const showWeb = options.web || (!options.api && !options.worker);
      const showWorker = options.worker || (!options.api && !options.web);
      const follow = !!options.follow;

      const tgts: { target: ServerTarget; show: boolean; label: string }[] = [
        { target: 'api', show: showApi, label: 'API' },
        { target: 'web', show: showWeb, label: 'Web' },
        { target: 'worker', show: showWorker, label: 'Worker' },
      ];

      const active = tgts.filter(t => t.show);
      if (active.length === 0) {
        console.log('  No log source selected. Use --api, --web, or --worker.');
        return;
      }

      for (const { target, label } of active) {
        const logPath = getLogPath(target);
        const size = formatBytes(getLogSizeBytes(target));
        console.log(`\n  ── ${label} logs (last ${lines} lines, ${size}) ──`);
        console.log(`  File: ${logPath}\n`);

        const logs = tailLogs(target, lines);
        if (logs.length === 0) console.log('  (empty)');
        else for (const line of logs) console.log(`  ${redactSecrets(line)}`);
      }

      if (follow) {
        console.log('\n  Watching for new log entries... Press Ctrl+C to stop.\n');
        for (const { target, label, show } of active) {
          if (show) console.log(`  tail -f ${getLogPath(target)}`);
        }
      }
      console.log('');
    });

  // ── ara server open ───────────────────────────────────────────
  server
    .command('open')
    .description('Open the Web UI in the default browser')
    .action(async () => {
      const json = readServerJson();
      if (!json || !json.processes.web.running) {
        const webPid = readPidFile('web');
        if (!webPid || !isRunning(webPid)) {
          console.log('\n  Web UI is not running.');
          console.log('  Start it with:  ara server start --with-web\n');
          return;
        }
      }
      const port = json?.processes.web.port || 5173;
      const url = `http://localhost:${port}`;
      console.log(`\n  Opening ${url} ...\n`);
      try {
        const { default: open } = await import('open');
        await open(url);
      } catch {
        const platform = process.platform;
        if (platform === 'darwin') {
          const { spawnSync } = await import('child_process');
          spawnSync('open', [url]);
        } else if (platform === 'win32') {
          const { spawnSync } = await import('child_process');
          spawnSync('cmd', ['/c', 'start', url]);
        } else {
          const { spawnSync } = await import('child_process');
          spawnSync('xdg-open', [url]);
        }
      }
    });

  // ── ara server prune-logs ─────────────────────────────────────
  server
    .command('prune-logs')
    .description('Prune rotated log files and trim oversized logs')
    .option('--api', 'Prune API logs only')
    .option('--web', 'Prune Web logs only')
    .option('--worker', 'Prune Worker logs only')
    .action(async (options) => {
      const t = options.api ? 'api' as ServerTarget
        : options.web ? 'web' as ServerTarget
        : options.worker ? 'worker' as ServerTarget
        : undefined;
      const result = pruneLogs(t);
      const freed = formatBytes(result.freedBytes);
      console.log(`\n  Pruned ${result.removed.length} files, freed ${freed}\n`);
      for (const f of result.removed) console.log(`  removed: ${f}`);
      if (result.removed.length === 0) console.log('  Nothing to prune.');
      console.log('');
    });

  // ── ara server clean ──────────────────────────────────────────
  server
    .command('clean')
    .description('Clean server state (stale PIDs, rotated logs, state file)')
    .action(async () => {
      console.log('\n  Cleaning server state...');
      const result = cleanServerState();
      if (result.removed.length > 0) {
        for (const f of result.removed) console.log(`  removed: ${f}`);
      } else {
        console.log('  Nothing to clean.');
      }
      console.log('');
    });

  // ── ara server doctor ─────────────────────────────────────────
  server
    .command('doctor')
    .description('Diagnose server state, config, logs, and processes')
    .action(async () => {
      const pass: string[] = [];
      const fail: string[] = [];
      const info: string[] = [];

      const ok = (msg: string) => { pass.push(msg); };
      const err = (msg: string) => { fail.push(msg); };
      const inf = (msg: string) => { info.push(msg); };

      console.log('\n  Ara Server Diagnostics');
      console.log('  ' + '─'.repeat(58));

      // State directory
      const { existsSync } = require('node:fs');
      if (existsSync(SERVER_DIR)) ok('.ara/server/ exists');
      else inf('.ara/server/ not yet created');

      // Logs directory
      const logsDir = require('node:path').join(SERVER_DIR, 'logs');
      if (existsSync(logsDir)) {
        ok('.ara/server/logs/ writable');
        // Check log sizes
        for (const t of ['api', 'web', 'worker'] as ServerTarget[]) {
          const size = getLogSizeBytes(t);
          if (size > 0) inf(`  ${t}.log: ${formatBytes(size)}`);
        }
      } else inf('.ara/server/logs/ not yet created');

      // Config
      const config = loadServerConfig();
      inf(`Config: ${configSource()} (apiPort=${config.apiPort}, logMaxBytes=${formatBytes(config.logMaxBytes)}, watchdog=${config.watchdogEnabled})`);

      // PID files
      for (const t of ['api', 'web', 'worker'] as ServerTarget[]) {
        const pid = readPidFile(t);
        if (pid !== null) {
          if (isRunning(pid)) ok(`${t} running (pid ${pid})`);
          else err(`Stale PID: ${t}.pid (pid ${pid})`);
        } else inf(`${t}: no PID file`);
      }

      // server.json
      const sj = readServerJson();
      if (sj) {
        ok('server.json valid');
        inf(`Uptime: ${formatUptime(sj.startedAt)}`);
        inf(`Restarts: ${sj.restartCount ?? 0}`);
        if (sj.lastCrash) inf(`Last crash: ${new Date(sj.lastCrash).toLocaleString()}`);
      } else inf('server.json not found (server has not been started)');

      // Port check
      const net = await import('node:net');
      const checkPort = (port: number): Promise<boolean> => new Promise(resolve => {
        const srv = net.createServer();
        srv.once('error', () => resolve(false));
        srv.once('listening', () => { srv.close(); resolve(true); });
        srv.listen(port, '127.0.0.1');
      });
      if (await checkPort(3001)) ok('Port 3001 (API) available');
      else inf('Port 3001 (API) in use');
      if (await checkPort(5173)) ok('Port 5173 (Web) available');
      else inf('Port 5173 (Web) in use');

      // Log sizes
      const totalLogSize = ['api', 'web', 'worker']
        .reduce((sum, t) => sum + getLogSizeBytes(t as ServerTarget), 0);
      if (totalLogSize > 0) inf(`Total log size: ${formatBytes(totalLogSize)}`);
      else inf('No log files yet');
// Backup storage      const { existsSync, readdirSync, statSync } = require("node:fs");      const pathMod = require("node:path");      const backupsDir = pathMod.join(process.cwd(), ".ara", "backups");      if (existsSync(backupsDir)) {        const files = readdirSync(backupsDir).filter((f) => f.endsWith(".bak"));        const totalSize = files.reduce((sum, f) => sum + statSync(pathMod.join(backupsDir, f)).size, 0);        inf(`Backups: ${files.length} files, ${formatBytes(totalSize)}`);      } else inf("No backups directory");      // Audit storage      const auditDir = pathMod.join(process.cwd(), ".ara", "audit");      if (existsSync(auditDir)) {        const files = readdirSync(auditDir).filter((f) => f.endsWith(".jsonl"));        const totalSize = files.reduce((sum, f) => sum + statSync(pathMod.join(auditDir, f)).size, 0);        inf(`Audit logs: ${files.length} files, ${formatBytes(totalSize)}`);      } else inf("No audit directory");      // System service status      const svc = getServiceStatus();      if (svc.installed) {        ok(`System service: ${svc.name} (${svc.type})`);        if (svc.running) ok("  Service is running");        else inf("  Service is installed but not active");      } else inf("System service not installed (run: ara server install)");

      console.log('  ' + '─'.repeat(58));
      console.log(`  ${pass.length} passed, ${fail.length} failed, ${info.length} info\n`);
    });

  // ── ara server install (system service for 24/7) ──────────────
  server
    .command('install')
    .description('Install Ara as a system service (auto-start on boot)')
    .action(async () => {
      console.log(`\n  Installing Ara server as system service...\n`);
      console.log(`  Platform: ${detectPlatform()}`);
      console.log(`  Bun: ${process.execPath}`);
      console.log(`  CWD: ${process.cwd()}\n`);

      const result = await installService();
      if (result.ok) {
        console.log('  ✓ Service installed successfully.');
        console.log('  ✓ Ara will start automatically on next boot.\n');
      } else {
        console.error(`  ✗ Failed: ${result.error}\n`);
      }
    });

  // ── ara server uninstall ─────────────────────────────────────
  server
    .command('uninstall')
    .description('Remove Ara system service (stop auto-start on boot)')
    .action(async () => {
      console.log('\n  Removing Ara system service...\n');
      const result = await uninstallService();
      if (result.ok) {
        console.log('  ✓ Service removed.\n');
      } else {
        console.error(`  ✗ Failed: ${result.error}\n`);
      }
    });

  return server;
}
