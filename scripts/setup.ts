import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

console.log('=============================================================');
console.log('         Ara Personal AI Control Plane Setup Wizard          ');
console.log('=============================================================');
console.log('Starting automated workspace initialization and dependency setup...\n');

// 1. Check Bun Installation
console.log('[1/4] Verifying Bun environment...');
const bunCheck = spawnSync('bun', ['--version'], { encoding: 'utf8' });
if (bunCheck.error || bunCheck.status !== 0) {
  console.error('❌ Error: Bun runtime was not found. Please install Bun from https://bun.sh first.');
  process.exit(1);
}
console.log(`✅ Bun environment found: v${bunCheck.stdout.trim()}\n`);

// 2. Install Workspace Dependencies
console.log('[2/4] Resolving monorepo packages and linking dependencies...');
const installResult = spawnSync('bun', ['install'], {
  stdio: 'inherit',
  shell: true
});

if (installResult.status !== 0) {
  console.error('❌ Error: Dependency installation failed.');
  process.exit(1);
}
console.log('✅ Monorepo packages successfully linked.\n');

// 3. Configure Local Environment File
console.log('[3/4] Checking environment configurations...');
const rootDir = process.cwd();
const envPath = path.join(rootDir, '.env');
const envExamplePath = path.join(rootDir, '.env.example');

if (!fs.existsSync(envPath)) {
  if (fs.existsSync(envExamplePath)) {
    fs.copyFileSync(envExamplePath, envPath);
    console.log('✅ Generated new local configuration: .env (copied from .env.example)');
    console.log('👉 Please edit .env to insert your target LLM provider API keys.');
  } else {
    console.warn('⚠️ Warning: .env.example was not found. Created empty .env file.');
    fs.writeFileSync(envPath, '');
  }
} else {
  console.log('✅ Existing local .env configuration detected.');
}
console.log('');

// 4. Create Runtime Directories
console.log('[4/4] Creating local workspace directory structure...');
const dirsToCreate = [
  path.join(rootDir, '.ara'),
  path.join(rootDir, '.ara', 'backups'),
  path.join(rootDir, '.ara', 'logs'),
  path.join(rootDir, '.ara', 'sessions'),
  path.join(rootDir, 'memory')
];

dirsToCreate.forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`✅ Created directory: ${path.relative(rootDir, dir)}`);
  }
});

console.log('\n=============================================================');
console.log('🎉 Setup Completed Successfully!');
console.log('=============================================================');
console.log('Ara Personal AI Control Plane is initialized and ready.');
console.log('\nTo start the web application, Hono backend, and background worker:');
console.log('   bun run dev');
console.log('\nTo interact via the terminal:');
console.log('   bun link');
console.log('   ara tui');
console.log('=============================================================');
