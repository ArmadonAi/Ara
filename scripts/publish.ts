import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

console.log('=============================================================');
console.log('          Ara Personal AI Control Plane NPM Publisher         ');
console.log('=============================================================');

const rootDir = process.cwd();
const cliDir = path.join(rootDir, 'apps', 'cli');
const pkgPath = path.join(cliDir, 'package.json');
const pkgBackupPath = path.join(cliDir, 'package.json.bak');

try {
  // 1. Verify NPM authentication
  console.log('[1/4] Verifying NPM authentication...');
  const npmWhoami = spawnSync('npm', ['whoami'], { encoding: 'utf8', shell: true });
  if (npmWhoami.status !== 0) {
    console.error('❌ Error: You are not logged in to NPM. Please run "npm login" first.');
    process.exit(1);
  }
  console.log(`✅ Logged in to NPM as: ${npmWhoami.stdout.trim()}`);

  // 2. Build the CLI package using the static bundle tool
  console.log('\n[2/4] Compiling static CLI standalone bundle...');
  const buildResult = spawnSync('bun', ['run', 'build:cli'], {
    stdio: 'inherit',
    shell: true
  });
  if (buildResult.status !== 0) {
    console.error('❌ Error: CLI compilation failed.');
    process.exit(1);
  }
  console.log('✅ CLI bundled successfully.');

  // 3. Prepare package.json for publishing
  console.log('\n[3/4] Preparing package.json for public NPM registry...');
  
  // Backup development package.json
  fs.copyFileSync(pkgPath, pkgBackupPath);

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  
  // Expose package as public instead of monorepo private
  delete pkg.private;
  
  // Clean workspace references since they are compiled into the standalone dist/main.js
  if (pkg.dependencies) {
    for (const key of Object.keys(pkg.dependencies)) {
      if (pkg.dependencies[key] === 'workspace:*') {
        delete pkg.dependencies[key];
      }
    }
  }

  // Write temporary publish package.json
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf8');
  console.log('✅ Temporary package.json sanitized successfully (workspace dependencies removed).');

  // 4. Run public publish command
  console.log('\n[4/4] Publishing @ara/cli to NPM registry...');
  const publishResult = spawnSync('npm', ['publish', '--access', 'public'], {
    cwd: cliDir,
    stdio: 'inherit',
    shell: true
  });

  if (publishResult.status !== 0) {
    throw new Error('NPM publish process failed.');
  }

  console.log('\n🎉 Package successfully published to NPM registry!');
} catch (err: any) {
  console.error(`\n❌ Error: ${err.message}`);
} finally {
  // Always restore original development settings
  if (fs.existsSync(pkgBackupPath)) {
    fs.copyFileSync(pkgBackupPath, pkgPath);
    fs.unlinkSync(pkgBackupPath);
    console.log('✅ Original development package.json successfully restored.');
  }
}
