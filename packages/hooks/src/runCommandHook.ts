import { evaluatePermission } from '@ara/permissions';
import type { CommandHookConfig, HookEventPayload, HookResult, HookDecision } from './types';
import * as path from 'node:path';

// Helper to scrub secrets recursively
export function scrubSecrets(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    // Mask API keys, tokens, SSH keys, passwords
    const secretPatterns = [
      /AIzaSy[a-zA-Z0-9_-]{33}/g, // Gemini
      /sk-[a-zA-Z0-9]{32,}/g, // OpenAI
      /xoxb-[a-zA-Z0-9-]{32,}/g, // Slack
      /ghp_[a-zA-Z0-9]{36}/g, // GitHub
      /bearer\s+[a-zA-Z0-9_-]+/gi, // Bearer Token
      /password\s*:\s*[^\s,]+/gi,
      /secret\s*:\s*[^\s,]+/gi
    ];
    let scrubbed = obj;
    for (const pat of secretPatterns) {
      scrubbed = scrubbed.replace(pat, '[MASKED_SECRET]');
    }
    return scrubbed;
  }
  if (Array.isArray(obj)) {
    return obj.map(item => scrubSecrets(item));
  }
  if (typeof obj === 'object') {
    const scrubbedObj: any = {};
    for (const key of Object.keys(obj)) {
      // Mask keys matching passwords, tokens, secrets
      const lowerKey = key.toLowerCase();
      if (
        lowerKey.includes('key') ||
        lowerKey.includes('secret') ||
        lowerKey.includes('token') ||
        lowerKey.includes('password') ||
        lowerKey.includes('auth')
      ) {
        scrubbedObj[key] = '[MASKED_SECRET]';
      } else {
        scrubbedObj[key] = scrubSecrets(obj[key]);
      }
    }
    return scrubbedObj;
  }
  return obj;
}

export async function runCommandHook(
  config: CommandHookConfig,
  payload: HookEventPayload,
  cwd: string = process.cwd()
): Promise<{ result: HookResult; output: string; exitCode?: number; error?: string }> {
  // 1. Evaluate command through Permission Engine first!
  const permRequest = {
    toolName: 'run_shell',
    input: { command: config.command },
    cwd,
    dangerLevel: 'dangerous' as const,
    sessionId: payload.sessionId,
    userId: 'default-user',
    permissionMode: payload.permissionMode
  };

  const permResult = evaluatePermission(permRequest);
  if (permResult.decision === 'deny') {
    return {
      result: {
        decision: 'block',
        reason: `Hook execution blocked by Permission Engine policy: ${permResult.reason}`
      },
      output: '',
      error: `Security Block: ${permResult.reason}`
    };
  }

  // 2. Prepare payload without secrets
  const cleanPayload = scrubSecrets(payload);

  // 3. Spawn command process with timeout and stdin
  const isWin = process.platform === 'win32';
  const shellCmd = isWin ? ['cmd.exe', '/c', config.command] : ['sh', '-c', config.command];
  const timeoutMs = config.timeoutMs || 10000;

  try {
    const stdinContent = JSON.stringify(cleanPayload) + '\n';
    const proc = Bun.spawn(shellCmd, {
      stdin: Buffer.from(stdinContent),
      stdout: 'pipe',
      stderr: 'pipe',
      cwd
    });

    let timeoutId: any;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        try {
          proc.kill();
        } catch (e) {}
        reject(new Error(`Hook command timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    const executionPromise = (async () => {
      const stdoutPromise = Bun.readableStreamToArrayBuffer(proc.stdout);
      const stderrPromise = Bun.readableStreamToArrayBuffer(proc.stderr);

      const [exitCode, stdoutBytes, stderrBytes] = await Promise.all([
        proc.exited,
        stdoutPromise,
        stderrPromise
      ]);
      
      clearTimeout(timeoutId);

      const stdout = new TextDecoder().decode(stdoutBytes);
      const stderr = new TextDecoder().decode(stderrBytes);

      return {
        exitCode,
        stdout,
        stderr
      };
    })();

    const finished = await Promise.race([executionPromise, timeoutPromise]);

    const combinedOutput = (finished.stdout + '\n' + finished.stderr).trim();
    // Truncate output to avoid memory bloating
    const maxOutputChars = 5000;
    const truncatedOutput = combinedOutput.length > maxOutputChars 
      ? combinedOutput.substring(0, maxOutputChars) + '\n... [Output Truncated]'
      : combinedOutput;

    // Determine hook result decision
    let decision: HookDecision = 'continue';
    let reason = '';

    // Check if exit code is 2 (explicit block)
    if (finished.exitCode === 2) {
      decision = 'block';
      reason = `Hook command returned exit code 2 (explicit block)`;
    } else if (finished.exitCode !== 0) {
      decision = 'warn';
      reason = `Hook command exited with non-zero status: ${finished.exitCode}`;
    }

    // Try parsing stdout as JSON to allow explicit override:
    // { "decision": "block", "reason": "..." }
    try {
      // Find the last line or JSON block in stdout
      const trimmedOut = finished.stdout.trim();
      const lastJsonIndex = trimmedOut.lastIndexOf('{');
      if (lastJsonIndex !== -1) {
        const jsonCandidate = trimmedOut.substring(lastJsonIndex);
        const parsed = JSON.parse(jsonCandidate);
        if (parsed && typeof parsed === 'object' && (parsed.decision === 'continue' || parsed.decision === 'block' || parsed.decision === 'warn')) {
          decision = parsed.decision;
          if (parsed.reason) {
            reason = parsed.reason;
          }
        }
      }
    } catch (e) {
      // Ignore parse failure, fall back to exit code baseline
    }

    return {
      result: { decision, reason },
      output: truncatedOutput,
      exitCode: finished.exitCode ?? undefined
    };

  } catch (err: any) {
    return {
      result: {
        decision: 'warn',
        reason: `Hook command failed execution: ${err.message}`
      },
      output: '',
      error: err.message
    };
  }
}
