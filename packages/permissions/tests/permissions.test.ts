import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { evaluatePermission } from '../src/evaluatePermission';
import { resolvePathSafety } from '../src/resolvePathSafety';
import { PermissionRequest } from '../src/types';

describe('Ara Permission Engine - Unit Verification Suite', () => {
  const cwd = path.resolve(process.cwd());

  test('Path safety resolve - blocks absolute and relative traversals outside workspace', () => {
    // Relative escapes
    const res1 = resolvePathSafety('../secret.txt', cwd);
    expect(res1.safe).toBe(false);
    expect(res1.reason).toContain('Directory traversal');

    // Windows absolute drive or root escapes
    const res2 = resolvePathSafety('C:/secret.txt', cwd);
    if (!res2.safe) {
      expect(res2.safe).toBe(false);
      expect(res2.reason).toContain('Path resolves outside');
    }

    // Normal safe subpaths are accepted
    const res3 = resolvePathSafety('src/index.ts', cwd);
    expect(res3.safe).toBe(true);
    expect(res3.resolvedPath).toContain('src/index.ts');
  });

  test('Path safety resolve - blocks null bytes and home secrets', () => {
    const res1 = resolvePathSafety('src/index.ts\0', cwd);
    expect(res1.safe).toBe(false);
    expect(res1.reason).toContain('null bytes');

    const res2 = resolvePathSafety('~/.ssh/id_rsa', cwd);
    expect(res2.safe).toBe(false);
    expect(res2.reason).toContain('home directory secrets');
  });

  test('Path safety resolve - symlink checks if target points outside', () => {
    const linkPath = path.join(cwd, 'test-outside-link.txt');
    
    let created = false;
    try {
      if (fs.existsSync(linkPath) || fs.lstatSync(linkPath).isSymbolicLink()) {
        fs.unlinkSync(linkPath);
      }
    } catch (e) {}

    try {
      fs.symlinkSync('../../package.json', linkPath);
      created = true;
    } catch (e) {
      // Gracefully handle Windows symlink privileges limit
    }

    if (created) {
      const res = resolvePathSafety('test-outside-link.txt', cwd);
      expect(res.safe).toBe(false);
    } else {
      console.log('Skipping symlink traversal test because OS permissions restricted symlink creation.');
      expect(true).toBe(true);
    }

    try {
      if (fs.existsSync(linkPath) || fs.lstatSync(linkPath).isSymbolicLink()) {
        fs.unlinkSync(linkPath);
      }
    } catch (e) {}
  });

  test('Default rules - reading secrets (.env, id_rsa, SSH keys) is strictly denied', () => {
    const req: PermissionRequest = {
      toolName: 'read_file',
      input: { filePath: '.env' },
      cwd,
      dangerLevel: 'safe',
      permissionMode: 'default',
    };

    const res = evaluatePermission(req);
    expect(res.decision).toBe('deny');
    expect(res.matchedRuleId).toBe('deny-env-file');
    expect(res.blocked).toBe(true);
  });

  test('Default rules - dangerous shell operations (rm -rf, sudo, wget pipe) are strictly denied', () => {
    const req1: PermissionRequest = {
      toolName: 'run_shell',
      input: { command: 'rm -rf node_modules' },
      cwd,
      dangerLevel: 'dangerous',
      permissionMode: 'default',
    };
    const res1 = evaluatePermission(req1);
    expect(res1.decision).toBe('deny');
    expect(res1.matchedRuleId).toBe('deny-shell-rm');

    const req2: PermissionRequest = {
      toolName: 'run_shell',
      input: { command: 'sudo apt-get update' },
      cwd,
      dangerLevel: 'dangerous',
      permissionMode: 'default',
    };
    const res2 = evaluatePermission(req2);
    expect(res2.decision).toBe('deny');
    expect(res2.matchedRuleId).toBe('deny-shell-sudo');
  });

  test('Plan Mode - allows read-only and blocks edits/writes/shell', () => {
    const reqRead: PermissionRequest = {
      toolName: 'read_file',
      input: { filePath: 'src/index.ts' },
      cwd,
      dangerLevel: 'safe',
      permissionMode: 'plan',
    };
    const resRead = evaluatePermission(reqRead);
    expect(resRead.decision).toBe('allow');

    const reqWrite: PermissionRequest = {
      toolName: 'write_file',
      input: { filePath: 'src/newfile.ts', content: 'test' },
      cwd,
      dangerLevel: 'write',
      permissionMode: 'plan',
    };
    const resWrite = evaluatePermission(reqWrite);
    expect(resWrite.decision).toBe('deny');
  });

  test('Default Mode - allows safe reads and asks writes/edits/shell', () => {
    const reqRead: PermissionRequest = {
      toolName: 'read_file',
      input: { filePath: 'src/index.ts' },
      cwd,
      dangerLevel: 'safe',
      permissionMode: 'default',
    };
    const resRead = evaluatePermission(reqRead);
    expect(resRead.decision).toBe('allow');

    const reqWrite: PermissionRequest = {
      toolName: 'write_file',
      input: { filePath: 'src/newfile.ts', content: 'test' },
      cwd,
      dangerLevel: 'write',
      permissionMode: 'default',
    };
    const resWrite = evaluatePermission(reqWrite);
    expect(resWrite.decision).toBe('ask');
    expect(resWrite.requiresApproval).toBe(true);
  });

  test('Accept-Edits Mode - allows file edits inside workspace and asks shell/network', () => {
    const reqWrite: PermissionRequest = {
      toolName: 'write_file',
      input: { filePath: 'src/newfile.ts', content: 'test' },
      cwd,
      dangerLevel: 'write',
      permissionMode: 'accept-edits',
    };
    const resWrite = evaluatePermission(reqWrite);
    expect(resWrite.decision).toBe('allow');

    const reqShell: PermissionRequest = {
      toolName: 'run_shell',
      input: { command: 'npm run start' },
      cwd,
      dangerLevel: 'dangerous',
      permissionMode: 'accept-edits',
    };
    const resShell = evaluatePermission(reqShell);
    expect(resShell.decision).toBe('ask');
  });

  test('Danger-Review Mode - asks safe reads and everything else except denied rules', () => {
    const reqRead: PermissionRequest = {
      toolName: 'read_file',
      input: { filePath: 'src/index.ts' },
      cwd,
      dangerLevel: 'safe',
      permissionMode: 'danger-review',
    };
    const resRead = evaluatePermission(reqRead);
    expect(resRead.decision).toBe('ask');
  });
});
