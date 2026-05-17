import type { PermissionRequest, PermissionResult, PermissionRule } from './types';
import { PermissionRequestSchema } from './schema';
import { resolvePathSafety } from './resolvePathSafety';
import { defaultDenyRules } from './defaultRules';
import { matchPathRule } from './matchPathRule';
import { matchCommandRule } from './matchCommandRule';
import { evaluateModeBaseline } from './permissionModes';

export function evaluatePermission(request: PermissionRequest): PermissionResult {
  // 1. Zod Validation
  const validation = PermissionRequestSchema.safeParse(request);
  if (!validation.success) {
    return {
      decision: 'deny',
      reason: `Malformed permission request: ${validation.error.message}`,
      requiresApproval: false,
      blocked: true,
    };
  }

  const req = validation.data;
  const toolName = req.toolName;
  const input = req.input || {};
  const cwd = req.cwd;
  const mode = req.permissionMode;

  // 2. Extract path parameter if tool uses files
  let originalPath = '';
  if (typeof input.filePath === 'string') {
    originalPath = input.filePath;
  } else if (typeof input.directory === 'string') {
    originalPath = input.directory;
  } else if (typeof input.targetPath === 'string') {
    originalPath = input.targetPath;
  } else if (typeof input.TargetFile === 'string') {
    originalPath = input.TargetFile;
  }

  let resolvedPath = '';
  if (originalPath) {
    const safety = resolvePathSafety(originalPath, cwd);
    if (!safety.safe) {
      return {
        decision: 'deny',
        reason: `Path Safety Violation: ${safety.reason || 'Invalid path structure'}`,
        requiresApproval: false,
        blocked: true,
      };
    }
    resolvedPath = safety.resolvedPath || '';
  }

  // 3. Extract command if it's shell execution
  let commandStr = '';
  if (toolName === 'run_shell' && typeof input.command === 'string') {
    commandStr = input.command;
  }

  // 4. Match against default deny rules (Credential leaks, Traversal, Escapes, Dangerous Shell commands)
  for (const rule of defaultDenyRules) {
    // Check path glob rules
    if (rule.pathGlob && (originalPath || resolvedPath)) {
      const matchOriginal = originalPath ? matchPathRule(originalPath, rule.pathGlob) : false;
      const matchResolved = resolvedPath ? matchPathRule(resolvedPath, rule.pathGlob) : false;
      if (matchOriginal || matchResolved) {
        return {
          decision: 'deny',
          matchedRuleId: rule.id,
          reason: `Security Rule Violation [${rule.id}]: ${rule.reason || 'Access denied by default safety rules'}`,
          requiresApproval: false,
          blocked: true,
        };
      }
    }

    // Check command pattern rules
    if (rule.commandPattern && commandStr) {
      if (matchCommandRule(commandStr, rule.commandPattern)) {
        return {
          decision: 'deny',
          matchedRuleId: rule.id,
          reason: `Security Rule Violation [${rule.id}]: ${rule.reason || 'Command execution blocked by security policy'}`,
          requiresApproval: false,
          blocked: true,
        };
      }
    }
  }

  // 5. Evaluate baseline permission mode decisions
  const baselineDecision = evaluateModeBaseline(mode, toolName, commandStr);

  if (baselineDecision === 'deny') {
    return {
      decision: 'deny',
      reason: `Blocked by Active Mode Policy [${mode.toUpperCase()}]: Execution of tool "${toolName}" is prohibited in this mode.`,
      requiresApproval: false,
      blocked: true,
    };
  }

  if (baselineDecision === 'ask') {
    return {
      decision: 'ask',
      reason: `Review Requested under Active Mode Policy [${mode.toUpperCase()}]: Execution of tool "${toolName}" requires verification.`,
      requiresApproval: true,
      blocked: false,
    };
  }

  // If allow
  return {
    decision: 'allow',
    reason: `Allowed by Active Mode Policy [${mode.toUpperCase()}]`,
    requiresApproval: false,
    blocked: false,
  };
}
