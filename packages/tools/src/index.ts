import type { Tool, ToolContext, ToolResult } from '@ara/shared';
export { compactJSONL, compactJSONLDir, getJSONLDirStats, getJSONLSize } from './maintenance';
import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';

// Lazy lock integration — fail-closed by default.
// Mutating operations require @ara/locks unless ARA_ALLOW_LOCK_FALLBACK=1.
let lockModule: any = null;
let lockFallbackWarned = false;

async function ensureLocks(): Promise<{ available: boolean; isFallback?: boolean }> {
  if (!lockModule) {
    try {
      lockModule = await import('@ara/locks');
    } catch {
      const allowFallback = process.env.ARA_ALLOW_LOCK_FALLBACK === '1';
      if (!allowFallback) {
        lockModule = { available: false, failClosed: true };
      } else {
        lockModule = { available: false, isFallback: true };
        if (!lockFallbackWarned) {
          lockFallbackWarned = true;
          try {
            lockModule.writeLockAudit?.('lock.unavailable_fallback', {
              sessionId: 'system',
              reason: 'ARA_ALLOW_LOCK_FALLBACK=1 — locks disabled',
            });
          } catch {}
        }
      }
    }
  }
  return lockModule;
}

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  register(tool: Tool) {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return Array.from(this.tools.values());
  }
}

// Helper to resolve and validate file paths inside the workspace cwd
function resolveSafePath(cwd: string, targetPath: string): string {
  const resolved = path.resolve(cwd, targetPath);
  if (!resolved.startsWith(path.resolve(cwd))) {
    throw new Error('Access denied: Cannot access files outside the current workspace directory.');
  }
  return resolved;
}

// Phase 8: Secrets & Credentials scanner to ensure safety
function scanForSecrets(content: string): string | null {
  const patterns = [
    { name: 'OpenAI API Key', regex: /sk-[a-zA-Z0-9]{32,}/g },
    { name: 'Google Cloud API Key', regex: /AIza[0-9A-Za-z-_]{35}/g },
    { name: 'Slack Token', regex: /xox[bapts]-[0-9a-zA-Z]{10,}/g },
    { name: 'Generic Password Assignment', regex: /(password|passwd|secret|api_key|token|auth_token)\s*=\s*['"][a-zA-Z0-9_.-]{8,}['"]/gi }
  ];

  for (const pattern of patterns) {
    if (pattern.regex.test(content)) {
      return pattern.name;
    }
  }
  return null;
}

// -------------------------------------------------------------
// 1. list_files Tool (Safe)
// -------------------------------------------------------------
export class ListFilesTool implements Tool {
  name = 'list_files';
  description = 'List all files and folders recursively inside the workspace directory.';
  dangerLevel = 'safe' as const;
  requiresApproval = false;
  inputSchema = z.object({
    directory: z.string().optional().default('.')
  });

  async run(input: { directory?: string }, ctx: ToolContext): Promise<ToolResult> {
    try {
      const targetDir = resolveSafePath(ctx.cwd, input.directory || '.');
      
      const files = await fs.readdir(targetDir, { recursive: true });
      // Filter out node_modules, .git, .sqlite, .ara/backups, etc.
      const filtered = files.filter(f => 
        !f.toString().includes('node_modules') && 
        !f.toString().includes('.git') && 
        !f.toString().includes('.ara') && 
        !f.toString().endsWith('.sqlite')
      );

      return {
        success: true,
        output: filtered.join('\n') || '[Directory is empty]'
      };
    } catch (e: any) {
      return { success: false, output: '', error: e.message };
    }
  }
}

// -------------------------------------------------------------
// 2. read_file Tool (Safe)
// -------------------------------------------------------------
export class ReadFileTool implements Tool {
  name = 'read_file';
  description = 'Read the exact text contents of a file inside the workspace directory.';
  dangerLevel = 'safe' as const;
  requiresApproval = false;
  inputSchema = z.object({
    filePath: z.string()
  });

  async run(input: { filePath: string }, ctx: ToolContext): Promise<ToolResult> {
    try {
      const targetPath = resolveSafePath(ctx.cwd, input.filePath);
      const content = await fs.readFile(targetPath, 'utf-8');
      return {
        success: true,
        output: content
      };
    } catch (e: any) {
      return { success: false, output: '', error: e.message };
    }
  }
}

// -------------------------------------------------------------
// 3. write_file Tool (Requires Approval + Checkpointing + Secret Scan)
// -------------------------------------------------------------
export class WriteFileTool implements Tool {
  name = 'write_file';
  description = 'Create a new file or completely overwrite an existing file with new content.';
  dangerLevel = 'write' as const;
  requiresApproval = true;
  inputSchema = z.object({
    filePath: z.string(),
    content: z.string()
  });

  async run(input: { filePath: string; content: string }, ctx: ToolContext): Promise<ToolResult> {
    // 1. Credentials Safety Check
    const secretFound = scanForSecrets(input.content);
    if (secretFound) {
      return {
        success: false,
        output: '',
        error: `Safety Block: Content contains exposed credentials: "${secretFound}"`
      };
    }

    const targetPath = resolveSafePath(ctx.cwd, input.filePath);
    let acquiredLockId: string | null = null;

    try {
      // 2. Acquire write lock for target file path (fail-closed)
      const locks = await ensureLocks();
      if (locks.failClosed) {
        return {
          success: false,
          output: '',
          error: '[LOCK SYSTEM UNAVAILABLE] File locking module not available. Set ARA_ALLOW_LOCK_FALLBACK=1 to bypass, or ensure @ara/locks is installed.'
        };
      }
      if (locks.available !== false) {
        const lockResult = locks.acquireLock({
          sessionId: ctx.sessionId,
          path: targetPath,
          mode: 'write',
          reason: `write_file: ${input.filePath}`,
          ttlMs: 30_000,
        });
        if (!lockResult.ok) {
          return {
            success: false,
            output: '',
            error: `[LOCK BLOCKED] ${lockResult.error || 'Could not acquire write lock for file'}`
          };
        }
        acquiredLockId = lockResult.lock!.id;
      }

      // 3. Phase 8: File Checkpointing / Backup before edit
      const exists = await fs.stat(targetPath).then(() => true).catch(() => false);
      if (exists) {
        const backupDir = path.join(ctx.cwd, '.ara', 'backups');
        await fs.mkdir(backupDir, { recursive: true });

        const relativePath = path.relative(ctx.cwd, targetPath);
        const backupName = `${relativePath.replace(/[\\/:]/g, '_')}_${Date.now()}.bak`;
        const backupPath = path.join(backupDir, backupName);

        const currentContent = await fs.readFile(targetPath, 'utf-8');
        await fs.writeFile(backupPath, currentContent, 'utf-8');
      }

      // 4. Ensure target directory exists and write file
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, input.content, 'utf-8');

      return {
        success: true,
        output: `File successfully written to ${input.filePath} (${input.content.length} characters). Backup created if file existed.`
      };
    } catch (e: any) {
      return { success: false, output: '', error: e.message };
    } finally {
      // 5. Release lock on success or failure
      if (acquiredLockId && locks.available !== false) {
        locks.releaseLock(acquiredLockId);
      }
    }
  }
}

// -------------------------------------------------------------
// 3b. edit_file Tool (Requires Approval + Checkpointing + Write Lock)
// -------------------------------------------------------------
export class EditFileTool implements Tool {
  name = 'edit_file';
  description = 'Edit an existing file by replacing a specific string with new content. Requires the file and oldString to exist.';
  dangerLevel = 'write' as const;
  requiresApproval = true;
  inputSchema = z.object({
    filePath: z.string(),
    oldString: z.string(),
    newString: z.string(),
    replaceAll: z.boolean().optional().default(false),
  });

  async run(input: { filePath: string; oldString: string; newString: string; replaceAll?: boolean }, ctx: ToolContext): Promise<ToolResult> {
    // 1. Credentials Safety Check
    const secretFound = scanForSecrets(input.newString);
    if (secretFound) {
      return {
        success: false,
        output: '',
        error: `Safety Block: Content contains exposed credentials: "${secretFound}"`
      };
    }

    const targetPath = resolveSafePath(ctx.cwd, input.filePath);
    let acquiredLockId: string | null = null;

    try {
      // 2. Acquire write lock for target file path (fail-closed)
      const locks = await ensureLocks();
      if (locks.failClosed) {
        return {
          success: false,
          output: '',
          error: '[LOCK SYSTEM UNAVAILABLE] File locking module not available. Set ARA_ALLOW_LOCK_FALLBACK=1 to bypass, or ensure @ara/locks is installed.'
        };
      }
      if (locks.available !== false) {
        const lockResult = locks.acquireLock({
          sessionId: ctx.sessionId,
          path: targetPath,
          mode: 'write',
          reason: `edit_file: ${input.filePath}`,
          ttlMs: 30_000,
        });
        if (!lockResult.ok) {
          return {
            success: false,
            output: '',
            error: `[LOCK BLOCKED] ${lockResult.error || 'Could not acquire write lock for file'}`
          };
        }
        acquiredLockId = lockResult.lock!.id;
      }

      // 3. Read current file content
      const exists = await fs.stat(targetPath).then(() => true).catch(() => false);
      if (!exists) {
        return { success: false, output: '', error: `File "${input.filePath}" does not exist. edit_file requires an existing file.` };
      }

      const currentContent = await fs.readFile(targetPath, 'utf-8');

      // 4. Validate oldString exists in file
      const occurrenceCount = currentContent.split(input.oldString).length - 1;
      if (occurrenceCount === 0) {
        return { success: false, output: '', error: `oldString "${input.oldString}" not found in "${input.filePath}".` };
      }
      if (!input.replaceAll && occurrenceCount > 1) {
        return {
          success: false,
          output: '',
          error: `oldString "${input.oldString}" found ${occurrenceCount} times in "${input.filePath}". Use replaceAll=true to replace all occurrences, or provide a more specific oldString.`
        };
      }

      // 5. Backup before edit
      const backupDir = path.join(ctx.cwd, '.ara', 'backups');
      await fs.mkdir(backupDir, { recursive: true });
      const relativePath = path.relative(ctx.cwd, targetPath);
      const backupName = `${relativePath.replace(/[\\/:]/g, '_')}_${Date.now()}.bak`;
      const backupPath = path.join(backupDir, backupName);
      await fs.writeFile(backupPath, currentContent, 'utf-8');

      // 6. Perform the edit
      const newContent = input.replaceAll
        ? currentContent.split(input.oldString).join(input.newString)
        : currentContent.replace(input.oldString, input.newString);

      await fs.writeFile(targetPath, newContent, 'utf-8');

      return {
        success: true,
        output: `File "${input.filePath}" edited successfully. Replaced ${occurrenceCount} occurrence(s). Backup saved to .ara/backups/.`
      };
    } catch (e: any) {
      return { success: false, output: '', error: e.message };
    } finally {
      // 7. Release lock on success or failure
      if (acquiredLockId) {
        const locks = await ensureLocks();
        if (locks.available !== false) locks.releaseLock(acquiredLockId);
      }
    }
  }
}

// -------------------------------------------------------------
// 4. run_shell Tool (Requires Strict Approval + Docker Sandboxing)
// -------------------------------------------------------------
export class RunShellTool implements Tool {
  name = 'run_shell';
  description = 'Run a safe terminal command inside the sandboxed local or Docker workspace shell environment.';
  dangerLevel = 'dangerous' as const;
  requiresApproval = true;
  inputSchema = z.object({
    command: z.string()
  });

  private blocklist = [
    'rm -rf', 'rm -f', 'rmdir',
    'sudo', 'su ', 'runas',
    'mv /', 'dd if',
    ':(){ :|:& };:', // Fork bomb
    'chmod -R', 'chown -R'
  ];

  // Detect if a shell command is potentially mutating (modifies files/workspace)
  private isMutatingCommand(cmd: string): boolean {
    const mutatingKeywords = [
      'write', 'edit', 'create', 'delete', 'remove', 'update', 'patch',
      'commit', 'push', 'merge', 'mv ', 'cp ', 'rm ', 'mkdir', 'touch',
      'chmod', 'chown', 'ln ', '>', '>>', '| tee',
    ];
    const lower = cmd.toLowerCase();
    return mutatingKeywords.some(k => lower.includes(k));
  }

  async run(input: { command: string }, ctx: ToolContext): Promise<ToolResult> {
    const cmd = input.command.trim();
    let acquiredLockId: string | null = null;

    // 1. Strict Security Allowed Command Check
    for (const blocked of this.blocklist) {
      if (cmd.toLowerCase().includes(blocked.toLowerCase())) {
        return {
          success: false,
          output: '',
          error: `Safety Block: command contains unsafe operation: "${blocked}"`
        };
      }
    }

    // 2. Credentials Safety Scan on Command Line
    const secretFound = scanForSecrets(cmd);
    if (secretFound) {
      return {
        success: false,
        output: '',
        error: `Safety Block: Command line contains exposed credentials: "${secretFound}"`
      };
    }

    // 3. Acquire workspace write lock for mutating commands (fail-closed)
    if (this.isMutatingCommand(cmd)) {
      const locks = await ensureLocks();
      if (locks.failClosed) {
        return {
          success: false,
          output: '',
          error: '[LOCK SYSTEM UNAVAILABLE] File locking module not available. Set ARA_ALLOW_LOCK_FALLBACK=1 to bypass, or ensure @ara/locks is installed.'
        };
      }
      if (locks.available !== false) {
        const lockResult = locks.acquireLock({
          sessionId: ctx.sessionId,
          path: ctx.cwd,
          mode: 'write',
          reason: `mutating shell: ${cmd.slice(0, 80)}`,
          ttlMs: 60_000,
        });
        if (!lockResult.ok) {
          return {
            success: false,
            output: '',
            error: `[LOCK BLOCKED] ${lockResult.error || 'Could not acquire write lock for workspace'}`
          };
        }
        acquiredLockId = lockResult.lock!.id;
      }
    }

    try {
      const isWindows = process.platform === 'win32';
      const useDocker = process.env.USE_DOCKER_SANDBOX === 'true';

      let execCmd: string[];
      if (useDocker) {
        // Run inside Docker sandbox mapping the current workspace directory!
        execCmd = [
          'docker', 'run', '--rm',
          '-v', `${ctx.cwd}:/workspace`,
          '-w', '/workspace',
          'node:20-alpine',
          'sh', '-c', cmd
        ];
      } else {
        // Run inside wrapped standard shell for full pipeline support
        execCmd = isWindows 
          ? ['powershell', '-Command', cmd]
          : ['sh', '-c', cmd];
      }

      // Execute subprocess cleanly using Bun.spawn
      const proc = Bun.spawn({
        cmd: execCmd,
        cwd: ctx.cwd,
        stdout: 'pipe',
        stderr: 'pipe'
      });

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        return {
          success: false,
          output: stdout,
          error: stderr || `Command exited with status code ${exitCode}`
        };
      }

      return {
        success: true,
        output: stdout || '[Command executed successfully with no stdout output]'
      };
    } catch (e: any) {
      return { success: false, output: '', error: e.message };
    } finally {
      // Release workspace lock if acquired for mutating command
      if (acquiredLockId) {
        const locks = await ensureLocks();
        if (locks.available !== false) locks.releaseLock(acquiredLockId);
      }
    }
  }
}

// -------------------------------------------------------------
// 5. git_status Tool (Safe)
// -------------------------------------------------------------
export class GitStatusTool implements Tool {
  name = 'git_status';
  description = 'Check the dirty status of the git repository.';
  dangerLevel = 'safe' as const;
  requiresApproval = false;
  inputSchema = z.object({});

  async run(input: any, ctx: ToolContext): Promise<ToolResult> {
    try {
      const proc = Bun.spawn({
        cmd: ['git', 'status'],
        cwd: ctx.cwd,
        stdout: 'pipe'
      });
      const stdout = await new Response(proc.stdout).text();
      return { success: true, output: stdout };
    } catch (e: any) {
      return { success: false, output: '', error: e.message };
    }
  }
}

// -------------------------------------------------------------
// 6. git_diff Tool (Safe)
// -------------------------------------------------------------
export class GitDiffTool implements Tool {
  name = 'git_diff';
  description = 'Check the current modifications/diff in the git repository.';
  dangerLevel = 'safe' as const;
  requiresApproval = false;
  inputSchema = z.object({});

  async run(input: any, ctx: ToolContext): Promise<ToolResult> {
    try {
      const proc = Bun.spawn({
        cmd: ['git', 'diff'],
        cwd: ctx.cwd,
        stdout: 'pipe'
      });
      const stdout = await new Response(proc.stdout).text();
      return { success: true, output: stdout || '[No changes detected]' };
    } catch (e: any) {
      return { success: false, output: '', error: e.message };
    }
  }
}
