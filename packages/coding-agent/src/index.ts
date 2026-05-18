// ─── Ara Coding Agent Integration ─────────────────────────────────
// Spawns and controls external coding agents (Codex CLI, Claude Code)
// as subprocesses with stdin/stdout piping and transcript storage.

import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── Types ────────────────────────────────────────────────────────

export interface CodexSessionInfo {
  id: string;
  binary: string;
  status: 'starting' | 'running' | 'stopped' | 'error';
  startTime: string;
  stopTime?: string;
  transcriptPath: string;
  outputLength: number;
}

export interface CodexSession {
  info: CodexSessionInfo;
  send(input: string): void;
  stop(): void;
  getOutput(): string;
  onOutput(cb: (text: string) => void): void;
}

// ─── Defaults ─────────────────────────────────────────────────────

const CODEX_DIR = path.join(process.cwd(), '.ara', 'codex');

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function detectBinary(): string {
  // Check environment variable override first
  if (process.env.ARA_CODEX_BINARY) return process.env.ARA_CODEX_BINARY;
  // Try common binaries in order
  const candidates = ['codex', 'claude'];
  for (const bin of candidates) {
    try {
      const which = Bun.which(bin);
      if (which) return bin;
    } catch {}
  }
  return 'codex'; // default name, will fail gracefully at spawn time
}

// ─── Session Manager ──────────────────────────────────────────────

class CodexSessionManagerImpl {
  private sessions = new Map<string, CodexSession>();
  private outputCallbacks = new Map<string, Set<(text: string) => void>>();

  // ── Start a new session ──────────────────────────────────────────

  start(binary?: string, initialPrompt?: string): CodexSession {
    ensureDir(CODEX_DIR);

    const bin = binary || detectBinary();
    const binPath = Bun.which(bin);
    if (!binPath) {
      throw new Error(
        `Coding agent binary "${bin}" not found.\n` +
        `Install: npm install -g @openai/codex  or  npm install -g @anthropic/claude-code`
      );
    }

    const id = `codex_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const transcriptPath = path.join(CODEX_DIR, `${id}.jsonl`);
    const startTime = new Date().toISOString();

    const info: CodexSessionInfo = {
      id, binary: bin, status: 'starting', startTime,
      transcriptPath, outputLength: 0,
    };

    // Spawn subprocess with pipes
    const proc = Bun.spawn([binPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let outputBuffer = '';
    let stopped = false;

    // Read stdout
    const readStdout = async () => {
      const reader = proc.stdout?.getReader();
      if (!reader) return;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = new TextDecoder().decode(value);
          outputBuffer += text;
          info.outputLength = outputBuffer.length;

          // Write to transcript
          try {
            fs.appendFileSync(transcriptPath, JSON.stringify({ type: 'stdout', text, ts: new Date().toISOString() }) + '\n');
          } catch {}

          // Notify callbacks
          const cbs = this.outputCallbacks.get(id);
          if (cbs) for (const cb of cbs) cb(text);
        }
      } catch {}
    };

    // Read stderr
    const readStderr = async () => {
      const reader = proc.stderr?.getReader();
      if (!reader) return;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = new TextDecoder().decode(value);
          try {
            fs.appendFileSync(transcriptPath, JSON.stringify({ type: 'stderr', text, ts: new Date().toISOString() }) + '\n');
          } catch {}
        }
      } catch {}
    };

    readStdout();
    readStderr();

    // Wait for process to be confirmed running
    info.status = 'running';

    // Handle process exit
    proc.exited.then((code) => {
      if (stopped) return;
      info.status = code === 0 ? 'stopped' : 'error';
      info.stopTime = new Date().toISOString();
      this.outputCallbacks.delete(id);
    });

    // Send initial prompt if provided
    if (initialPrompt) {
      this.sendInput(proc, id, initialPrompt);
    }

    const session: CodexSession = {
      info,
      send: (input: string) => this.sendInput(proc, id, input),
      stop: () => {
        stopped = true;
        proc.kill();
        info.status = 'stopped';
        info.stopTime = new Date().toISOString();
        this.outputCallbacks.delete(id);
      },
      getOutput: () => outputBuffer,
      onOutput: (cb: (text: string) => void) => {
        if (!this.outputCallbacks.has(id)) {
          this.outputCallbacks.set(id, new Set());
        }
        this.outputCallbacks.get(id)!.add(cb);
      },
    };

    this.sessions.set(id, session);
    return session;
  }

  // ── Send input to a session ──────────────────────────────────────

  private sendInput(proc: any, id: string, input: string) {
    const writer = proc.stdin?.getWriter();
    if (!writer) throw new Error('Session stdin not available');
    writer.write(new TextEncoder().encode(input + '\n'));
    writer.releaseLock();

    // Record input in transcript
    try {
      const tp = path.join(CODEX_DIR, `${id}.jsonl`);
      fs.appendFileSync(tp, JSON.stringify({ type: 'stdin', text: input, ts: new Date().toISOString() }) + '\n');
    } catch {}
  }

  // ── Get a session by ID ──────────────────────────────────────────

  get(id: string): CodexSession | undefined {
    return this.sessions.get(id);
  }

  // ── List all sessions ────────────────────────────────────────────

  list(): CodexSessionInfo[] {
    return Array.from(this.sessions.values()).map(s => s.info);
  }

  // ── Remove a completed session from registry ──────────────────────

  remove(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (s.info.status === 'running') s.stop();
    this.sessions.delete(id);
    this.outputCallbacks.delete(id);
    return true;
  }
}

// Singleton
let instance: CodexSessionManagerImpl | null = null;

export function getCodexSessionManager(): CodexSessionManagerImpl {
  if (!instance) instance = new CodexSessionManagerImpl();
  return instance;
}

export function resetCodexSessionManager(): void {
  for (const s of instance?.list() || []) {
    if (s.status === 'running') instance?.get(s.id)?.stop();
  }
  instance = null;
}
