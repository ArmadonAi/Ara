import { loadHookConfig } from './loadHookConfig';
import { runCommandHook } from './runCommandHook';
import { runHttpHook } from './runHttpHook';
import { writeHookAuditLog } from './hookAudit';
import type { HookEventName, HookEventPayload, HookResult, HookAuditRecord, HookDecision } from './types';

export async function runHooks(
  event: HookEventName,
  payload: HookEventPayload,
  cwd: string = process.cwd(),
  dbPath?: string
): Promise<HookResult> {
  // 1. Load active hooks configuration
  const { hooks } = loadHookConfig(cwd);
  const matchedHooks = hooks[event] || [];

  if (matchedHooks.length === 0) {
    return { decision: 'continue' };
  }

  let finalDecision: HookDecision = 'continue';
  let blockReason = '';

  for (const hook of matchedHooks) {
    // A. Matcher check (if matcher is present, check if payload toolName matches)
    if (hook.matcher && payload.toolName && payload.toolName !== hook.matcher) {
      continue;
    }

    const id = Math.random().toString(36).substring(7);
    const startedAt = new Date().toISOString();
    const startTime = Date.now();

    let decision: HookDecision = 'continue';
    let reason = '';
    let output = '';
    let errorMsg = '';
    let status: 'success' | 'failed' = 'success';

    // B. Dispatch execution based on hook type
    if (hook.type === 'command') {
      const exec = await runCommandHook(hook, payload, cwd);
      decision = exec.result.decision;
      reason = exec.result.reason || '';
      output = exec.output;
      if (exec.error) {
        errorMsg = exec.error;
        status = 'failed';
      }
    } else if (hook.type === 'http') {
      const exec = await runHttpHook(hook, payload);
      decision = exec.result.decision;
      reason = exec.result.reason || '';
      output = exec.output;
      if (exec.error) {
        errorMsg = exec.error;
        status = 'failed';
      }
    }

    const durationMs = Date.now() - startTime;
    const finishedAt = new Date().toISOString();

    // C. Write Audit Log
    const auditRecord: HookAuditRecord = {
      id,
      sessionId: payload.sessionId,
      event,
      hookName: hook.name,
      hookType: hook.type,
      matcher: hook.matcher,
      commandOrUrl: hook.type === 'command' ? hook.command : hook.url,
      status,
      decision,
      reason,
      startedAt,
      finishedAt,
      durationMs,
      outputSummary: output,
      error: errorMsg || undefined
    };

    writeHookAuditLog(auditRecord, dbPath);

    // D. Process decision block/warn logic
    if (decision === 'block') {
      finalDecision = 'block';
      blockReason = reason || `Blocked by hook: ${hook.name}`;
      break; // Immediately halt subsequent hooks
    } else if (decision === 'warn') {
      finalDecision = 'warn';
      blockReason = reason || `Warning raised by hook: ${hook.name}`;
    }
  }

  return {
    decision: finalDecision,
    reason: finalDecision !== 'continue' ? blockReason : undefined
  };
}
