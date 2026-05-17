import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

console.log('🚀 Starting CLI Compilation...');

// 1. Run Bun build
const buildRes = spawnSync('bun', ['build', 'src/main.tsx', '--outfile=dist/main.js', '--target=bun'], { stdio: 'inherit' });
if (buildRes.status !== 0) {
  process.exit(buildRes.status || 1);
}

const findYogaWasm = (dir: string): string | null => {
  try {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file);
      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch (e) {
        continue;
      }
      if (file === 'yoga.wasm') {
        return fullPath;
      }
      if (stat.isDirectory()) {
        const found = findYogaWasm(fullPath);
        if (found) return found;
      }
    }
  } catch (e) {}
  return null;
};

try {
  const rootNodeModules = path.resolve((import.meta as any).dir, '../../node_modules');
  const wasmPath = findYogaWasm(rootNodeModules);

  if (wasmPath) {
    const destDir = path.resolve((import.meta as any).dir, 'dist');
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    const destPath = path.join(destDir, 'yoga.wasm');
    fs.copyFileSync(wasmPath, destPath);
    console.log(`✅ Copied yoga.wasm from ${wasmPath} to ${destPath}`);
  } else {
    console.warn('⚠️ Warning: Could not locate yoga.wasm under node_modules.');
  }
} catch (err) {
  console.error('Error copying yoga.wasm:', err);
}

console.log('🎉 CLI built successfully!');
