import type {
  MCPServerConfig,
  MCPDiscoveredTool,
  MCPPermissionInput,
  MCPPermissionOutput,
} from './types';

/**
 * Map an external MCP tool call to an Ara PermissionRequest-compatible decision.
 *
 * Hard-denies before anything else:
 *  - server is disabled
 *  - tool is explicitly denied in server config
 *  - tool has a secret file path
 *  - server is not on the explicit allowlist AND not trusted
 *  - untrusted server requesting secrets/credentials
 */
export function mapPermission(input: MCPPermissionInput): MCPPermissionOutput {
  const { serverConfig, tool, permissionMode, trustLevel } = input;
  const isTrusted = trustLevel === 'trusted';
  const isUntrusted = !isTrusted;

  // 1. Hard deny if server disabled
  if (!serverConfig.enabled) {
    return {
      decision: 'deny',
      dangerLevel: 'dangerous',
      requiresApproval: true,
      reason: `MCP server "${serverConfig.id}" is disabled`,
    };
  }

  // 2. Hard deny if tool explicitly denied
  if (serverConfig.deniedTools.length > 0 && serverConfig.deniedTools.includes(tool.name)) {
    return {
      decision: 'deny',
      dangerLevel: 'dangerous',
      requiresApproval: true,
      reason: `Tool "${tool.name}" is explicitly denied for server "${serverConfig.id}"`,
    };
  }

  // 3. Hard deny — secrets in tool name or any path-based input
  const denySecretsRewrites: [string[]][] = [
    ['secret', '.env', 'credential', 'token', 'api_key', 'private_key', 'ssh_key', 'aws_secret', 'password']
  ];
  const anyText = `${tool.name} ${tool.description} ${JSON.stringify(input.input)}`;
  for (const p of denySecretsRewrites[0]) {
    if (anyText.toLowerCase().includes(p) && !isTrusted) {
      return {
        decision: 'deny',
        dangerLevel: 'dangerous',
        requiresApproval: true,
        reason: `Secret/token-sensitive external tool denied: "${tool.name}" (untrusted server)`,
      };
    }
  }

  // 4. Allowlist gate
  const allowlist = serverConfig.allowedTools;
  if (allowlist.length > 0 && !allowlist.includes(tool.name)) {
    return {
      decision: 'deny',
      dangerLevel: tool.dangerLevel,
      requiresApproval: true,
      reason: `Tool "${tool.name}" is not in the ${serverConfig.id} server allowlist`,
    };
  }

  // 5. Shell-like tools from untrusted server → deny (checked before mutating so dangerous tools are denied, not asked)
  const toolNameLower = tool.name.toLowerCase();
  const shellLikeWords = ['run', 'exec', 'command', 'shell', 'terminal', 'script', 'npm', 'pip', 'apt'];
  if (isUntrusted && shellLikeWords.some(w => toolNameLower.includes(w))) {
    return {
      decision: 'deny',
      dangerLevel: 'dangerous',
      requiresApproval: true,
      reason: `Shell-like tool "${tool.name}" on untrusted server "${serverConfig.id}" is denied`,
    };
  }

  // 6. Untrusted write/mutating tools → ask
  if (isUntrusted && (tool.mutating || tool.dangerLevel === 'write' || tool.dangerLevel === 'dangerous')) {
    return {
      decision: 'ask',
      dangerLevel: tool.dangerLevel,
      requiresApproval: true,
      reason: `Untrusted server "${serverConfig.id}" — mutating tool "${tool.name}" requires manual approval`,
    };
  }

  // 7. Network tools from untrusted server → ask unless trusted
  if (isUntrusted && tool.dangerLevel === 'network') {
    return {
      decision: 'ask',
      dangerLevel: 'network',
      requiresApproval: true,
      reason: `Untrusted server "${serverConfig.id}" — network tool "${tool.name}" requires domain approval`,
    };
  }

  // 8. File tools from untrusted server → path safety check first
  if (isUntrusted && toolNameLower.includes('file')) {
    // Still require approval for file access from untrusted servers
    return {
      decision: 'ask',
      dangerLevel: 'write',
      requiresApproval: true,
      reason: `File tool "${tool.name}" on untrusted server "${serverConfig.id}" requires path-safety approval`,
    };
  }

  // 9. Trusted server bypass — trusted servers pass all tool calls through
  // as long as they passed the earlier hard denies (disabled, denied list, secrets, allowlist)
  if (isTrusted) {
    return {
      decision: 'allow',
      dangerLevel: tool.dangerLevel,
      requiresApproval: false,
      reason: `Trusted server "${serverConfig.id}" — tool "${tool.name}" is allowed`,
    };
  }

  // 10. Default: mode-based
  const modeBaselines: Record<string, MCPPermissionOutput> = {
    default: {
      decision: 'ask',
      dangerLevel: tool.dangerLevel,
      requiresApproval: tool.dangerLevel === 'write' || tool.dangerLevel === 'dangerous',
      reason: `External tool "${tool.name}" on "${serverConfig.id}" defaults to ask (default mode)`,
    },
    'accept-edits': {
      decision: tool.mutating ? 'ask' : 'allow',
      dangerLevel: tool.dangerLevel,
      requiresApproval: tool.mutating
        ? tool.dangerLevel === 'write' || tool.dangerLevel === 'network'
        : false,
      reason: `External tool "${tool.name}" — accepted-edits mode`,
    },
    plan: {
      decision: 'ask',
      dangerLevel: tool.dangerLevel,
      requiresApproval: true,
      reason: `Plan mode — all external access requires approval`,
    },
    'auto-safe': {
      decision: 'allow',
      dangerLevel: 'safe',
      requiresApproval: false,
      reason: `Auto-safe mode — no external mutation tools allowed by default`,
    },
    'danger-review': {
      decision: 'ask',
      dangerLevel: tool.dangerLevel,
      requiresApproval: true,
      reason: `Danger-review mode — all external tools require approval`,
    },
  };

  return modeBaselines[permissionMode] || modeBaselines.default;
}

// Convenience helper
export function shouldRequireApproval(
  serverConfig: MCPServerConfig,
  tool: MCPDiscoveredTool,
  permissionMode: string = 'default'
): boolean {
  const result = mapPermission({
    serverConfig,
    tool,
    input: {},
    permissionMode,
    trustLevel: serverConfig.trusted ? 'trusted' : 'untrusted',
  });
  return result.decision === 'ask';
}
