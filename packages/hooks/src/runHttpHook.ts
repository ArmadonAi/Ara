import type { HttpHookConfig, HookEventPayload, HookResult, HookDecision } from './types';
import { scrubSecrets } from './runCommandHook';

export async function runHttpHook(
  config: HttpHookConfig,
  payload: HookEventPayload
): Promise<{ result: HookResult; output: string; statusCode?: number; error?: string }> {
  // 1. Scrub secrets before sending
  const cleanPayload = scrubSecrets(payload);
  const timeoutMs = config.timeoutMs || 10000;

  // 2. Abort controller for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  const defaultHeaders = {
    'Content-Type': 'application/json',
    'User-Agent': 'Ara-Hooks-System/0.1.0'
  };

  const headers = {
    ...defaultHeaders,
    ...(config.headers || {})
  };

  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(cleanPayload),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    const responseText = await response.text();
    const truncatedResponse = responseText.length > 5000
      ? responseText.substring(0, 5000) + '\n... [Response Truncated]'
      : responseText;

    let decision: HookDecision = 'continue';
    let reason = '';

    if (!response.ok) {
      decision = 'warn';
      reason = `HTTP Hook responded with non-ok status: ${response.status}`;
    }

    // Try parsing response as JSON to find decision details
    try {
      const parsed = JSON.parse(responseText.trim());
      if (parsed && typeof parsed === 'object' && (parsed.decision === 'continue' || parsed.decision === 'block' || parsed.decision === 'warn')) {
        decision = parsed.decision;
        if (parsed.reason) {
          reason = parsed.reason;
        }
      }
    } catch (e) {
      // Fallback to HTTP status code baseline
    }

    return {
      result: { decision, reason },
      output: truncatedResponse,
      statusCode: response.status
    };

  } catch (err: any) {
    clearTimeout(timeoutId);
    const isTimeout = err.name === 'AbortError';
    const errorMsg = isTimeout ? `HTTP hook timed out after ${timeoutMs}ms` : err.message;
    return {
      result: {
        decision: 'warn',
        reason: `HTTP hook execution failed: ${errorMsg}`
      },
      output: '',
      error: errorMsg
    };
  }
}
