#!/usr/bin/env node
// Standalone desktop binary packaging script for Lore.
// Bundles compiled CLI, production dependencies, native SQLite bindings, and Node runtime
// into self-contained portable distribution archives with SHA-256 integrity checksums.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  rmSync,
  copyFileSync,
  chmodSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// Parse command line arguments
const args = process.argv.slice(2);
function getArg(flag, fallback) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const targetPlatform = getArg('--platform', process.platform);
const targetArch = getArg('--arch', process.arch);
const outDir = path.resolve(getArg('--out-dir', path.join(ROOT, 'dist', 'binaries')));
const targetName = `lore-v${pkg.version}-${targetPlatform}-${targetArch}`;

console.log(`[PACKAGING] Building standalone desktop package for ${targetName}...`);

// Ensure output directory exists
mkdirSync(outDir, { recursive: true });

// Create clean staging area
const stageDir = path.join(outDir, `stage-${targetPlatform}-${targetArch}`);
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

// 1. Bundle runtime libraries and CLI
const libDir = path.join(stageDir, 'lib');
mkdirSync(libDir, { recursive: true });
cpSync(path.join(ROOT, 'dist'), path.join(libDir, 'dist'), { recursive: true });
copyFileSync(path.join(ROOT, 'package.json'), path.join(libDir, 'package.json'));

// 2. Stage production dependencies
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
let rawList = '';
try {
  rawList = execFileSync(npmCmd, ['list', '--omit=dev', '--parseable', '--all'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
} catch {
  // Fallback to direct production node_modules copy if npm list fails
}

const targetModules = path.join(libDir, 'node_modules');
mkdirSync(targetModules, { recursive: true });

if (rawList) {
  const pkgPaths = rawList.trim().split(/\r?\n/).slice(1);
  for (const pkgPath of pkgPaths) {
    if (!pkgPath) continue;
    const rel = path.relative(path.join(ROOT, 'node_modules'), pkgPath);
    if (existsSync(pkgPath)) {
      cpSync(pkgPath, path.join(targetModules, rel), { recursive: true });
    }
  }
} else {
  // Direct production dependencies copy
  const prodDeps = Object.keys(pkg.dependencies || {});
  for (const dep of prodDeps) {
    const src = path.join(ROOT, 'node_modules', dep);
    if (existsSync(src)) {
      cpSync(src, path.join(targetModules, dep), { recursive: true });
    }
  }
}

// Ensure better-sqlite3 native addon exists in stage
const bSqlitePrebuilds = path.join(ROOT, 'node_modules', 'better-sqlite3', 'prebuilds');
const targetBSqlite = path.join(targetModules, 'better-sqlite3');
if (existsSync(bSqlitePrebuilds) && existsSync(targetBSqlite)) {
  cpSync(bSqlitePrebuilds, path.join(targetBSqlite, 'prebuilds'), { recursive: true });
}

// 3. Stage Node runtime
const runtimeDir = path.join(stageDir, 'runtime');
mkdirSync(runtimeDir, { recursive: true });
const nodeName = targetPlatform === 'win32' ? 'node.exe' : 'node';
const nodeTarget = path.join(runtimeDir, nodeName);
copyFileSync(process.execPath, nodeTarget);
if (targetPlatform !== 'win32') {
  chmodSync(nodeTarget, 0o755);
}

// 4. Create launcher executables
const binDir = path.join(stageDir, 'bin');
mkdirSync(binDir, { recursive: true });

if (targetPlatform === 'win32') {
  const cmdScript = `@echo off
setlocal
set "DIR=%~dp0"
"%DIR%..\\runtime\\node.exe" "%DIR%..\\lib\\dist\\cli.js" %*
endlocal
`;
  writeFileSync(path.join(binDir, 'lore.cmd'), cmdScript, 'utf8');
} else {
  const shScript = `#!/usr/bin/env bash
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/../runtime/node" "$DIR/../lib/dist/cli.js" "$@"
`;
  const loreBin = path.join(binDir, 'lore');
  writeFileSync(loreBin, shScript, 'utf8');
  chmodSync(loreBin, 0o755);
}

// 5. Create distribution archives
const archiveBase = path.join(outDir, targetName);
let archiveFile = '';

if (targetPlatform === 'win32') {
  archiveFile = `${archiveBase}.zip`;
  // Use PowerShell to create zip on Windows
  execFileSync('powershell.exe', [
    '-Command',
    `Compress-Archive -Path "${stageDir}\\*" -DestinationPath "${archiveFile}" -Force`,
  ]);
} else {
  archiveFile = `${archiveBase}.tar.gz`;
  execFileSync('tar', ['-czf', archiveFile, '-C', stageDir, '.']);
}

// 6. Generate SHA-256 integrity checksums
function sha256File(file) {
  const data = readFileSync(file);
  return createHash('sha256').update(data).digest('hex');
}

const archiveHash = sha256File(archiveFile);
const checksumFile = path.join(outDir, 'SHA256SUMS.txt');
const checksumLine = `${archiveHash}  ${path.basename(archiveFile)}\n`;

let existingChecksums = '';
if (existsSync(checksumFile)) {
  existingChecksums = readFileSync(checksumFile, 'utf8');
}

// Replace existing line for this archive or append
const baseName = path.basename(archiveFile);
const lines = existingChecksums
  .split('\n')
  .filter((l) => l && !l.endsWith(`  ${baseName}`));
lines.push(`${archiveHash}  ${baseName}`);
writeFileSync(checksumFile, lines.join('\n') + '\n', 'utf8');

const mb = (file) => `${(statSync(file).size / 1024 / 1024).toFixed(1)} MB`;
console.log(`[OK] Created standalone package: ${archiveFile} (${mb(archiveFile)})`);
console.log(`[OK] SHA-256: ${archiveHash}`);
console.log(`[OK] Checksums updated in ${checksumFile}`);
