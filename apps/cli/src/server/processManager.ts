import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Types ──────────────────────────────────────────────────────────

export type ServerTarget = 'api' | 'web' | 'worker';

export interface ProcessInfo {
  pid: number;
  startedAt: string;
}

export interface ServerState {
  running: boolean;
  pid?: number;
  port?: number;
  url?: string;
  health: 'unknown' | 'healthy' | 'unhealthy';
  lastError?: string;
}

export interface ServerStatus {
  startedAt: string;
  processes: Record<ServerTarget, ServerState>;
  uptime: string;
  restartCount: number;
  lastCrash?: string;
  watchdogEnabled: boolean;
  configSource: 'default' | 'file';
  logSizes: Record<ServerTarget, number>;
}

export interface ServerConfig {
  apiPort: number;
  webPort: number;
  withWeb: boolean;
  withWorker: boolean;
  logMaxBytes: number;
  logMaxFiles: number;
  watchdogEnabled: boolean;
  restartLimit: number;
}

export interface StartOptions {
  apiPort?: number;
  webPort?: number;
  apiOnly?: boolean;
  withWeb?: boolean;
  withWorker?: boolean;
  foreground?: boolean;
  watchdog?: boolean;
}

export interface WatchdogState {
  enabled: boolean;
  restartCounts: Record<ServerTarget, number>;
  lastCrashTimes: Record<ServerTarget, string | undefined>;
  timerId: ReturnType<typeof setInterval> | null;
}

// ─── Defaults ───────────────────────────────────────────────────────

export const DEFAULT_CONFIG: ServerConfig = {
  apiPort: 3001,
  webPort: 5173,
  withWeb: false,
  withWorker: true,
  logMaxBytes: 10 * 1024 * 1024,  // 10 MB
  logMaxFiles: 3,
  watchdogEnabled: false,
  restartLimit: 3,
};

// ─── Paths ──────────────────────────────────────────────────────────

const CWD = process.cwd();
export const SERVER_DIR = path.join(CWD, '.ara', 'server');
const LOGS_DIR = path.join(SERVER_DIR, 'logs');
const SERVER_JSON = path.join(SERVER_DIR, 'server.json');
const CONFIG_PATH = path.join(SERVER_DIR, 'config.json');

function pidFilePath(target: ServerTarget): string {
  return path.join(SERVER_DIR, `${target}.pid`);
}

export function logFilePath(target: ServerTarget): string {
  return path.join(LOGS_DIR, `${target}.log`);
}

function rotatedLogPath(target: ServerTarget, index: number): string {
  return path.join(LOGS_DIR, `${target}.log.${index}`);
}

// ─── Watchdog state (global, set by start command) ──────────────────

export const watchdogState: WatchdogState = {
  enabled: false,
  restartCounts: { api: 0, web: 0, worker: 0 },
  lastCrashTimes: { api: undefined, web: undefined, worker: undefined },
  timerId: null,
};

// ─── Server config ──────────────────────────────────────────────────

export function loadServerConfig(): ServerConfig {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      apiPort: parsed.apiPort ?? DEFAULT_CONFIG.apiPort,
      webPort: parsed.webPort ?? DEFAULT_CONFIG.webPort,
      withWeb: parsed.withWeb ?? DEFAULT_CONFIG.withWeb,
      withWorker: parsed.withWorker ?? DEFAULT_CONFIG.withWorker,
      logMaxBytes: parsed.logMaxBytes ?? DEFAULT_CONFIG.logMaxBytes,
      logMaxFiles: parsed.logMaxFiles ?? DEFAULT_CONFIG.logMaxFiles,
      watchdogEnabled: parsed.watchdogEnabled ?? DEFAULT_CONFIG.watchdogEnabled,
      restartLimit: parsed.restartLimit ?? DEFAULT_CONFIG.restartLimit,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveServerConfig(config: ServerConfig): void {
  ensureDirs();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

export function configSource(): 'default' | 'file' {
  try {
    return fs.existsSync(CONFIG_PATH) ? 'file' : 'default';
  } catch {
    return 'default';
  }
}

// ─── Process helpers ────────────────────────────────────────────────

export function isRunning(pid: number): boolean {
  try {
    return process.kill(pid, 0);
  } catch {
    return false;
  }
}

export function killProcess(pid: number, signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

export function forceKillOnWindows(pid: number): boolean {
  try {
    // On Windows, taskkill is more reliable than SIGKILL
    if (process.platform === 'win32') {
      const { spawnSync } = require('child_process');
      const result = spawnSync('taskkill', ['/PID', String(pid), '/F'], { timeout: 5000 });
      return result.status === 0;
    }
    // On Unix, SIGKILL works fine
    return killProcess(pid, 'SIGKILL');
  } catch {
    return false;
  }
}

export function startProcess(
  target: ServerTarget,
  options: StartOptions = {}
): ProcessInfo | null {
  const scriptPath = resolveScriptPath(target);
  if (!scriptPath) return null;

  const args = buildArgs(target, options);
  ensureDirs();

  // Check log rotation before writing
  rotateLogIfNeeded(target, options);

  const logFile = logFilePath(target);
  const logStream = fs.openSync(logFile, 'a');

  try {
    const proc = Bun.spawn(args, {
      env: { ...process.env },
      detached: !options.foreground,
      stdout: logStream,
      stderr: logStream,
    });

    if (!options.foreground) proc.unref();

    const info: ProcessInfo = {
      pid: proc.pid,
      startedAt: new Date().toISOString(),
    };

    writePidFile(target, info.pid);

    if (options.foreground) {
      proc.stdout?.pipeTo?.(Bun.stdout);
      proc.stderr?.pipeTo?.(Bun.stderr);
    }

    return info;
  } catch (e: any) {
    fs.closeSync(logStream);
    return null;
  }
}

export async function stopProcess(
  target: ServerTarget
): Promise<{ ok: boolean; error?: string }> {
  const pid = readPidFile(target);
  if (!pid) return { ok: true };

  if (!isRunning(pid)) {
    removePidFile(target);
    return { ok: true, error: 'Process was not running' };
  }

  // Phase 1: Graceful SIGTERM
  const termOk = killProcess(pid, 'SIGTERM');

  // Phase 2: Wait up to 5 seconds for graceful shutdown
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (!isRunning(pid)) {
      removePidFile(target);
      return { ok: true };
    }
  }

  // Phase 3: Force kill (with platform-specific fallback)
  const killed = forceKillOnWindows(pid);
  if (!killed) {
    // Final attempt: direct SIGKILL
    killProcess(pid, 'SIGKILL');
  }

  // Wait briefly
  await new Promise(r => setTimeout(r, 500));

  if (!isRunning(pid)) {
    removePidFile(target);
    return { ok: true, error: 'Force killed after timeout' };
  }

  // Last resort: try taskkill /F on any platform
  try {
    const { spawnSync } = require('child_process');
    spawnSync('taskkill', ['/PID', String(pid), '/F'], { timeout: 3000 });
  } catch {}

  removePidFile(target);
  return { ok: false, error: 'Could not terminate process' };
}

export function stopAll(): Promise<{ ok: boolean; results: Record<ServerTarget, { ok: boolean; error?: string }> }> {
  const targets: ServerTarget[] = ['worker', 'web', 'api'];
  return Promise.all(targets.map(async t => {
    const result = await stopProcess(t);
    return [t, result] as const;
  })).then(results => ({
    ok: results.every(r => r[1].ok),
    results: Object.fromEntries(results) as any,
  }));
}

// ─── Health checks ──────────────────────────────────────────────────

export async function checkHealth(target: ServerTarget): Promise<'healthy' | 'unhealthy' | 'unknown'> {
  switch (target) {
    case 'api': {
      const port = getConfiguredPort('api');
      if (!port) return 'unknown';
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
          signal: AbortSignal.timeout(3000),
        });
        return res.ok ? 'healthy' : 'unhealthy';
      } catch { return 'unhealthy'; }
    }
    case 'web': {
      const port = getConfiguredPort('web');
      if (!port) return 'unknown';
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`, {
          signal: AbortSignal.timeout(3000),
        });
        return res.ok ? 'healthy' : 'unhealthy';
      } catch { return 'unhealthy'; }
    }
    case 'worker': {
      const pid = readPidFile('worker');
      if (!pid) return 'unknown';
      return isRunning(pid) ? 'healthy' : 'unhealthy';
    }
  }
}

// ─── Port checking ──────────────────────────────────────────────────

export async function isPortInUse(port: number): Promise<boolean> {
  try {
    const listener = Bun.listen({
      port, hostname: '127.0.0.1', reusePort: true,
      fetch() { return new Response(''); },
    });
    listener.stop();
    return false;
  } catch { return true; }
}

export async function findAvailablePort(start: number, end: number = start + 100): Promise<number | null> {
  for (let port = start; port <= end; port++) {
    if (!(await isPortInUse(port))) return port;
  }
  return null;
}

// ─── PID file management ────────────────────────────────────────────

export function ensureDirs(): void {
  if (!fs.existsSync(SERVER_DIR)) fs.mkdirSync(SERVER_DIR, { recursive: true });
  if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
}

export function writePidFile(target: ServerTarget, pid: number): void {
  ensureDirs();
  fs.writeFileSync(pidFilePath(target), String(pid), 'utf8');
}

export function readPidFile(target: ServerTarget): number | null {
  const file = pidFilePath(target);
  try {
    if (!fs.existsSync(file)) return null;
    const content = fs.readFileSync(file, 'utf8').trim();
    const pid = parseInt(content, 10);
    return isNaN(pid) ? null : pid;
  } catch { return null; }
}

export function removePidFile(target: ServerTarget): void {
  const file = pidFilePath(target);
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {}
}

// ─── Server JSON state ──────────────────────────────────────────────

export function readServerJson(): ServerStatus | null {
  try {
    if (!fs.existsSync(SERVER_JSON)) return null;
    const raw = fs.readFileSync(SERVER_JSON, 'utf8');
    return JSON.parse(raw) as ServerStatus;
  } catch { return null; }
}

export function writeServerJson(status: ServerStatus): void {
  ensureDirs();
  fs.writeFileSync(SERVER_JSON, JSON.stringify(status, null, 2), 'utf8');
}

export function buildServerStatus(
  apiPort: number,
  webPort: number,
  apiPid?: number,
  webPid?: number,
  workerPid?: number,
  restartCount: number = 0,
  lastCrash?: string,
  watchdog: boolean = false
): ServerStatus {
  const now = new Date().toISOString();
  const startedAt = now;

  const apiState: ServerState = apiPid
    ? { running: true, pid: apiPid, port: apiPort, url: `http://localhost:${apiPort}`, health: 'unknown' }
    : { running: false, health: 'unknown' };

  const webState: ServerState = webPid
    ? { running: true, pid: webPid, port: webPort, url: `http://localhost:${webPort}`, health: 'unknown' }
    : { running: false, health: 'unknown' };

  const workerState: ServerState = workerPid
    ? { running: true, pid: workerPid, health: 'unknown' }
    : { running: false, health: 'unknown' };

  return {
    startedAt,
    processes: { api: apiState, web: webState, worker: workerState },
    uptime: '0s',
    restartCount,
    lastCrash,
    watchdogEnabled: watchdog,
    configSource: configSource(),
    logSizes: { api: getLogSizeBytes('api'), web: getLogSizeBytes('web'), worker: getLogSizeBytes('worker') },
  };
}

export function formatUptime(startedAt: string): string {
  try {
    const start = new Date(startedAt).getTime();
    const now = Date.now();
    const diff = Math.floor((now - start) / 1000);
    if (diff < 60) return `${diff}s`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ${diff % 60}s`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m`;
    return `${Math.floor(diff / 86400)}d ${Math.floor((diff % 86400) / 3600)}h`;
  } catch { return '?'; }
}

// ─── Log management ─────────────────────────────────────────────────

export function getLogSizeBytes(target: ServerTarget): number {
  const file = logFilePath(target);
  try {
    if (!fs.existsSync(file)) return 0;
    return fs.statSync(file).size;
  } catch { return 0; }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function rotateLogIfNeeded(target: ServerTarget, options?: StartOptions): void {
  const config = loadServerConfig();
  const maxBytes = config.logMaxBytes;
  const maxFiles = config.logMaxFiles;
  const file = logFilePath(target);

  try {
    if (!fs.existsSync(file)) return;
    const size = fs.statSync(file).size;
    if (size < maxBytes) return;

    // Rotate existing backups
    for (let i = maxFiles - 1; i >= 1; i--) {
      const from = rotatedLogPath(target, i);
      const to = rotatedLogPath(target, i + 1);
      if (fs.existsSync(from)) {
        try { fs.renameSync(from, to); } catch {}
      }
    }

    // Move current log to .1
    fs.renameSync(file, rotatedLogPath(target, 1));
  } catch {}
}

export function pruneLogs(target?: ServerTarget): { removed: string[]; freedBytes: number } {
  const removed: string[] = [];
  let freedBytes = 0;
  const targets: ServerTarget[] = target ? [target] : ['api', 'web', 'worker'];

  for (const t of targets) {
    const maxFiles = loadServerConfig().logMaxFiles;

    // Remove rotated files beyond maxFiles
    for (let i = maxFiles + 1; ; i++) {
      const rf = rotatedLogPath(t, i);
      try {
        if (!fs.existsSync(rf)) break;
        freedBytes += fs.statSync(rf).size;
        fs.unlinkSync(rf);
        removed.push(rf);
      } catch { break; }
    }

    // Trim current log to last 10k lines if too large
    const main = logFilePath(t);
    try {
      if (fs.existsSync(main)) {
        const size = fs.statSync(main).size;
        if (size > 5 * 1024 * 1024) {
          const content = fs.readFileSync(main, 'utf8');
          const lines = content.split('\n');
          if (lines.length > 10000) {
            const trimmed = lines.slice(-10000).join('\n') + '\n';
            const oldSize = Buffer.byteLength(content, 'utf8');
            const newSize = Buffer.byteLength(trimmed, 'utf8');
            fs.writeFileSync(main, trimmed, 'utf8');
            freedBytes += oldSize - newSize;
            removed.push(main + ' (trimmed)');
          }
        }
      }
    } catch {}
  }

  return { removed, freedBytes };
}

export function cleanServerState(): { removed: string[] } {
  const removed: string[] = [];

  // Remove PID files
  for (const t of ['api', 'web', 'worker'] as ServerTarget[]) {
    const pf = pidFilePath(t);
    if (fs.existsSync(pf)) {
      const pid = readPidFile(t);
      if (pid !== null && isRunning(pid)) continue; // Don't clean running
      try {
        fs.unlinkSync(pf);
        removed.push(pf);
      } catch {}
    }
  }

  // Remove old rotated logs
  for (const t of ['api', 'web', 'worker'] as ServerTarget[]) {
    for (let i = 1; ; i++) {
      const rf = rotatedLogPath(t, i);
      try {
        if (!fs.existsSync(rf)) break;
        fs.unlinkSync(rf);
        removed.push(rf);
      } catch { break; }
    }
  }

  // Remove server.json
  if (fs.existsSync(SERVER_JSON)) {
    try {
      fs.unlinkSync(SERVER_JSON);
      removed.push(SERVER_JSON);
    } catch {}
  }

  return { removed };
}

export function tailLogs(target: ServerTarget, lines: number = 50): string[] {
  const file = logFilePath(target);
  try {
    if (!fs.existsSync(file)) return [];
    const content = fs.readFileSync(file, 'utf8');
    const allLines = content.split('\n').filter(Boolean);
    return allLines.slice(-lines);
  } catch { return []; }
}

export function getLogPath(target: ServerTarget): string {
  return logFilePath(target);
}

// ─── Secret redaction ───────────────────────────────────────────────

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9-]{20,}/g,
  /sk-ant-[A-Za-z0-9]{20,}/g,
  /ghp_[A-Za-z0-9]{36}/g,
  /github_pat_[A-Za-z0-9_]{50,}/g,
  /glpat-[A-Za-z0-9_-]{20,}/g,
  /Authorization:\s*Bearer\s+\S+/gi,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
];

export function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (match) => {
      if (/authorization/i.test(match)) return 'Authorization: Bearer ***';
      return match.slice(0, 4) + '***' + match.slice(-1);
    });
  }
  return result;
}

// ─── Stale PID cleanup ──────────────────────────────────────────────

export function cleanupStalePids(): { cleaned: string[] } {
  const targets: ServerTarget[] = ['api', 'web', 'worker'];
  const cleaned: string[] = [];
  for (const target of targets) {
    const pid = readPidFile(target);
    if (pid !== null && !isRunning(pid)) {
      removePidFile(target);
      cleaned.push(target);
    }
  }
  return { cleaned };
}

// ─── Internal helpers ───────────────────────────────────────────────

function resolveScriptPath(target: ServerTarget): string[] | null {
  switch (target) {
    case 'api': return ['bun', 'run', path.join(CWD, 'apps', 'api', 'src', 'index.ts')];
    case 'web': return ['bun', 'run', '--cwd', path.join(CWD, 'apps', 'web'), 'dev'];
    case 'worker': return ['bun', 'run', path.join(CWD, 'apps', 'worker', 'src', 'index.ts')];
  }
}

function buildArgs(target: ServerTarget, options: StartOptions): string[] {
  const script = resolveScriptPath(target);
  if (!script) return ['bun', 'run', 'echo', 'unknown-target'];
  return script;
}

function getConfiguredPort(target: ServerTarget): number | null {
  if (target === 'api') {
    const state = readPidInfo('api');
    return state?.port ?? 3001;
  }
  if (target === 'web') {
    const state = readPidInfo('web');
    return state?.port ?? 5173;
  }
  return null;
}

function readPidInfo(target: ServerTarget): { pid?: number; port?: number } | null {
  const json = readServerJson();
  if (!json) return null;
  const state = json.processes[target];
  if (!state) return null;
  return { pid: state.pid, port: state.port };
}

// ─── Watchdog ───────────────────────────────────────────────────────

export function startWatchdog(
  onRestart: (target: ServerTarget, attempt: number) => void
): void {
  if (watchdogState.timerId !== null) return; // Already running
  watchdogState.enabled = true;

  const config = loadServerConfig();
  const maxRestarts = config.restartLimit;

  watchdogState.timerId = setInterval(async () => {
    if (!watchdogState.enabled) return;

    for (const target of ['api', 'web', 'worker'] as ServerTarget[]) {
      const pid = readPidFile(target);
      if (pid === null) continue; // Not supposed to be running

      const running = isRunning(pid);
      if (running) {
        // Check health for API/Web
        if (target === 'api' || target === 'web') {
          const health = await checkHealth(target).catch(() => 'unhealthy' as const);
          if (health === 'unhealthy') {
            // Process running but not responding — could be starting up, skip
            continue;
          }
        }
        continue; // All good
      }

      // Process crashed
      const restartCount = watchdogState.restartCounts[target];
      if (restartCount >= maxRestarts) {
        continue; // Max restarts reached
      }

      // Record crash
      watchdogState.lastCrashTimes[target] = new Date().toISOString();
      watchdogState.restartCounts[target]++;

      // Backoff: wait longer after each restart
      const backoffMs = Math.min(1000 * Math.pow(2, restartCount), 30000);
      await new Promise(r => setTimeout(r, backoffMs));

      // Restart
      removePidFile(target);
      const info = startProcess(target, {});
      if (info) {
        writePidFile(target, info.pid);
        onRestart(target, restartCount + 1);

        // Update server.json
        const json = readServerJson();
        if (json) {
          json.processes[target] = {
            ...json.processes[target],
            running: true,
            pid: info.pid,
            health: 'unknown',
            lastError: undefined,
          };
          json.restartCount = Object.values(watchdogState.restartCounts).reduce((a, b) => a + b, 0);
          json.lastCrash = watchdogState.lastCrashTimes[target];
          writeServerJson(json);
        }
      }
    }
  }, 5000); // Check every 5 seconds
}

export function stopWatchdog(): void {
  watchdogState.enabled = false;
  if (watchdogState.timerId !== null) {
    clearInterval(watchdogState.timerId);
    watchdogState.timerId = null;
  }
}

export function resetRestartCounts(): void {
  watchdogState.restartCounts = { api: 0, web: 0, worker: 0 };
}

// ─── Start API wrapper ──────────────────────────────────────────────

export async function startApiServer(
  options: StartOptions = {}
): Promise<{ ok: boolean; port: number; pid?: number; error?: string }> {
  const port = options.apiPort || 3001;
  const existingPid = readPidFile('api');

  if (existingPid && isRunning(existingPid)) {
    return { ok: true, port, pid: existingPid, error: 'Already running' };
  }

  const inUse = await isPortInUse(port);
  if (inUse) {
    return { ok: false, port, error: `Port ${port} is already in use by another process` };
  }

  if (existingPid && !isRunning(existingPid)) removePidFile('api');

  const info = startProcess('api', { ...options, apiPort: port });
  if (!info) return { ok: false, port, error: 'Failed to start API server process' };

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 200));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) return { ok: true, port, pid: info.pid };
    } catch {}
  }

  return { ok: true, port, pid: info.pid, error: 'Started but not yet healthy' };
}

// ─── System Service Installation (24/7 auto-start) ─────────────

export interface ServiceInfo {
  installed: boolean;
  running: boolean;
  type: 'systemd' | 'launchd' | 'windows-schedule' | 'unknown';
  name: string;
}

function getBunPath(): string {
  return process.execPath; // Full path to Bun binary
}

function getScriptPath(): string {
  return path.join(CWD, 'apps', 'api', 'src', 'index.ts');
}

export function detectPlatform(): 'linux' | 'darwin' | 'win32' | 'unknown' {
  if (process.platform === 'linux') return 'linux';
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'win32') return 'win32';
  return 'unknown';
}

export async function installService(): Promise<{ ok: boolean; error?: string }> {
  const platform = detectPlatform();
  const bunPath = getBunPath();
  const scriptPath = getScriptPath();
  const cwd = CWD;
  const user = os.userInfo().username;

  try {
    switch (platform) {
      case 'win32': {
        // Windows: Create scheduled task that starts on logon
        const taskName = 'AraServer';
        const psCmd = [
          `$action = New-ScheduledTaskAction -Execute '${bunPath.replace(/'/g, "''")}' -Argument 'run ${scriptPath.replace(/'/g, "''")}' -WorkingDirectory '${cwd.replace(/'/g, "''")}'`,
          `$trigger = New-ScheduledTaskTrigger -AtLogOn -User '${user}'`,
          `$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)`,
          `Register-ScheduledTask -TaskName '${taskName}' -Action $action -Trigger $trigger -Settings $settings -Force`,
        ].join('; ');

        const proc = Bun.spawn(['powershell.exe', '-NoProfile', '-Command', psCmd], {
          env: { ...process.env },
        });
        const exitCode = await proc.exited;
        if (exitCode !== 0) {
          return { ok: false, error: `PowerShell exit code ${exitCode}` };
        }
        return { ok: true };
      }

      case 'linux': {
        // Linux: Create systemd user service
        const serviceContent = [
          '[Unit]',
          'Description=Ara AI Control Plane',
          'After=network.target',
          '',
          '[Service]',
          `Type=simple`,
          `ExecStart=${bunPath} run ${scriptPath}`,
          `WorkingDirectory=${cwd}`,
          `Restart=always`,
          `RestartSec=10`,
          `User=${user}`,
          `Environment=NODE_ENV=production`,
          '',
          '[Install]',
          'WantedBy=default.target',
        ].join('\n');

        const servicePath = path.join(os.homedir(), '.config', 'systemd', 'user', 'ara.service');
        const dir = path.dirname(servicePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(servicePath, serviceContent, 'utf-8');

        // Enable and start
        const enableProc = Bun.spawn(['systemctl', '--user', 'enable', 'ara.service'], { env: { ...process.env } });
        await enableProc.exited;
        const daemonProc = Bun.spawn(['systemctl', '--user', 'daemon-reload'], { env: { ...process.env } });
        await daemonProc.exited;

        return { ok: true };
      }

      case 'darwin': {
        // macOS: Create launchd plist
        const label = 'com.ara.server';
        const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
        const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${bunPath}</string>
        <string>run</string>
        <string>${scriptPath}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${cwd}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${path.join(CWD, '.ara', 'server', 'logs', 'api.log')}</string>
    <key>StandardErrorPath</key>
    <string>${path.join(CWD, '.ara', 'server', 'logs', 'api.log')}</string>
</dict>
</plist>`;

        const dir = path.dirname(plistPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(plistPath, plistContent, 'utf-8');

        const loadProc = Bun.spawn(['launchctl', 'load', plistPath], { env: { ...process.env } });
        await loadProc.exited;

        return { ok: true };
      }

      default:
        return { ok: false, error: `Unsupported platform: ${platform}` };
    }
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

export async function uninstallService(): Promise<{ ok: boolean; error?: string }> {
  const platform = detectPlatform();

  try {
    switch (platform) {
      case 'win32': {
        const taskName = 'AraServer';
        const proc = Bun.spawn(['powershell.exe', '-NoProfile', '-Command',
          `Unregister-ScheduledTask -TaskName '${taskName}' -Confirm:$false`],
          { env: { ...process.env } });
        const exitCode = await proc.exited;
        return { ok: exitCode === 0, error: exitCode !== 0 ? `PowerShell exit code ${exitCode}` : undefined };
      }

      case 'linux': {
        const servicePath = path.join(os.homedir(), '.config', 'systemd', 'user', 'ara.service');
        if (fs.existsSync(servicePath)) {
          const disableProc = Bun.spawn(['systemctl', '--user', 'disable', 'ara.service'], { env: { ...process.env } });
          await disableProc.exited;
          fs.unlinkSync(servicePath);
        }
        const daemonProc = Bun.spawn(['systemctl', '--user', 'daemon-reload'], { env: { ...process.env } });
        await daemonProc.exited;
        return { ok: true };
      }

      case 'darwin': {
        const label = 'com.ara.server';
        const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
        if (fs.existsSync(plistPath)) {
          const unloadProc = Bun.spawn(['launchctl', 'unload', plistPath], { env: { ...process.env } });
          await unloadProc.exited;
          fs.unlinkSync(plistPath);
        }
        return { ok: true };
      }

      default:
        return { ok: false, error: `Unsupported platform: ${platform}` };
    }
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

export function getServiceStatus(): ServiceInfo {
  const platform = detectPlatform();

  switch (platform) {
    case 'win32': {
      const taskName = 'AraServer';
      try {
        const result = Bun.spawnSync(['powershell.exe', '-NoProfile', '-Command',
          `$t = Get-ScheduledTask -TaskName '${taskName}' -ErrorAction SilentlyContinue; if ($t) { $t.State } else { 'NotPresent' }`],
          { env: { ...process.env } });
        const state = result.stdout.toString().trim();
        return {
          installed: state !== 'NotPresent' && state !== '',
          running: state === 'Running' || state === 'Ready',
          type: 'windows-schedule',
          name: taskName,
        };
      } catch {
        return { installed: false, running: false, type: 'windows-schedule', name: 'AraServer' };
      }
    }

    case 'linux': {
      const servicePath = path.join(os.homedir(), '.config', 'systemd', 'user', 'ara.service');
      if (!fs.existsSync(servicePath)) {
        return { installed: false, running: false, type: 'systemd', name: 'ara' };
      }
      try {
        const result = Bun.spawnSync(['systemctl', '--user', 'is-active', 'ara.service'], { env: { ...process.env } });
        const active = result.stdout.toString().trim() === 'active';
        return { installed: true, running: active, type: 'systemd', name: 'ara' };
      } catch {
        return { installed: true, running: false, type: 'systemd', name: 'ara' };
      }
    }

    case 'darwin': {
      const label = 'com.ara.server';
      const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
      if (!fs.existsSync(plistPath)) {
        return { installed: false, running: false, type: 'launchd', name: label };
      }
      try {
        const result = Bun.spawnSync(['launchctl', 'list', label], { env: { ...process.env } });
        return { installed: true, running: result.exitCode === 0, type: 'launchd', name: label };
      } catch {
        return { installed: true, running: false, type: 'launchd', name: label };
      }
    }

    default:
      return { installed: false, running: false, type: 'unknown', name: 'ara' };
  }
}
