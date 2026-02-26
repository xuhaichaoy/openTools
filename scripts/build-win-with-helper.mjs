#!/usr/bin/env node
/**
 * 编译 screen-capture-helper 并复制到 src-tauri/bin。
 * - 仅复制：node scripts/build-win-with-helper.mjs
 * - 复制后并打 Windows 包：node scripts/build-win-with-helper.mjs --build
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const helperCrate = path.join(root, 'crates', 'screen-capture-helper');
const binDir = path.join(root, 'src-tauri', 'bin');
const exeName = 'screen-capture-helper.exe';
const releaseExe = path.join(helperCrate, 'target', 'release', exeName);
const destExe = path.join(binDir, exeName);

const doTauriBuild = process.argv.includes('--build');

console.log('Building screen-capture-helper (release)...');
const cargo = spawnSync('cargo', ['build', '--release'], {
  cwd: helperCrate,
  stdio: 'inherit',
  shell: true,
});
if (cargo.status !== 0) {
  console.error('cargo build --release failed');
  process.exit(1);
}

if (!fs.existsSync(releaseExe)) {
  console.error('Expected binary not found:', releaseExe);
  process.exit(1);
}

if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });
fs.copyFileSync(releaseExe, destExe);
console.log('Copied', exeName, 'to', binDir);

if (!doTauriBuild) {
  console.log('Done. Run pnpm tauri:dev and the screenshot tool will use this helper.');
  process.exit(0);
}

console.log('Running tauri build...');
const tauri = spawnSync('pnpm', ['tauri', 'build'], { cwd: root, stdio: 'inherit', shell: true });
process.exit(tauri.status ?? 1);
