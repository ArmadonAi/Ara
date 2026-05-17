import { getActiveLocks, queryLocks } from './lockStore';
import { detectConflicts } from './lockManager';
import type { LockRequest } from './types';

/**
 * Detect circular wait deadlocks.
 *
 * A deadlock requires a CYCLE: session A holds lock on resource X and
 * waits for resource Y (held by B), while B holds Y and waits for X (held by A).
 *
 * A simple conflict on the SAME resource is NOT a deadlock — it's contention.
 */
export function detectDeadlock(
  request: LockRequest
): { deadlock: boolean; cycle?: string[]; message?: string } {
  const activeLocks = getActiveLocks();

  // Step 1: Find sessions that hold locks conflicting with our request.
  // These are the sessions we're "waiting for".
  const waitingFor = new Set<string>();

  for (const lock of activeLocks) {
    if (lock.sessionId === request.sessionId &&
        (!lock.runId || !request.runId || lock.runId === request.runId)) continue;

    if (lock.mode === 'write' || request.mode === 'write') {
      const reqPath = request.path.replace(/\\/g, '/').toLowerCase();
      const lockPath = lock.realPath.replace(/\\/g, '/').toLowerCase();
      if (reqPath === lockPath || reqPath.startsWith(lockPath + '/') || lockPath.startsWith(reqPath + '/')) {
        waitingFor.add(lock.sessionId + ':' + (lock.runId || ''));
      }
    }
  }

  if (waitingFor.size === 0) return { deadlock: false };

  // Step 2: For each session we're waiting for, check if THEY are waiting for US
  // on a DIFFERENT resource. This creates a cycle.
  for (const waitKey of waitingFor) {
    const [targetSession, targetRun] = waitKey.split(':');
    const targetLocks = queryLocks({
      sessionId: targetSession,
      runId: targetRun || undefined,
      status: 'active',
    });

    // Check if the target has any lock that conflicts with OUR *other* resources
    // (not the one we're currently requesting, but resources we already hold)
    const ourHeldPaths = activeLocks
      .filter(l =>
        l.sessionId === request.sessionId &&
        (!l.runId || !request.runId || l.runId === request.runId)
      )
      .map(l => l.realPath.replace(/\\/g, '/').toLowerCase());

    for (const tlock of targetLocks) {
      if (tlock.mode !== 'write') continue;

      const tPath = tlock.realPath.replace(/\\/g, '/').toLowerCase();

      // Check if this target lock conflicts with any of OUR held resources
      for (const ourPath of ourHeldPaths) {
        if (ourPath === tPath || ourPath.startsWith(tPath + '/') || tPath.startsWith(ourPath + '/')) {
          // Cycle detected: we wait for them, they wait for us
          return {
            deadlock: true,
            cycle: [waitKey, `${request.sessionId}:${request.runId || ''}`],
            message: `Deadlock detected between sessions: "${waitKey}" and "${request.sessionId}:${request.runId || ''}". ` +
              `"${waitKey}" holds "${tlock.path}" and needs "${request.path}". ` +
              `"${request.sessionId}" holds "${ourPath}" and needs "${tlock.path}".`,
          };
        }
      }
    }
  }

  return { deadlock: false };
}
