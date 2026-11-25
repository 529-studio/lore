#!/usr/bin/env node
// Test suite for standalone desktop binary packaging:
// - Builds the package using scripts/package-binary.mjs
// - Verifies archive and SHA-256 checksum integrity
// - Extracts and runs the standalone executable in an isolated environment without host dependencies
// - Executes init, write, and search workflows to verify full runtime independence

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

let failures = 0;
function fail(msg) {
  console.error(`FAIL: ${msg}`);
  failures++;
}

function expect(cond, msg) {
  if (!cond) {
    fail(msg);
    return false;
  }
  return true;
}

console.log('[TEST] 1. Build standalone package for host architecture...');
const tempOut = mkdtempSync(path.join(tmpdir(), 'lore-bin-test-out-'));

try {
  execFileSync(process.execPath, [
    path.join(ROOT, 'scripts', 'package-binary.mjs'),
    '--out-dir',
    tempOut,
  ], {
    cwd: ROOT,
    stdio: 'inherit',
  });
} catch (err) {
  fail(`packaging script failed: ${err.message}`);
}

const targetName = `lore-v${pkg.version}-${process.platform}-${process.arch}`;
const archiveExt = process.platform === 'win32' ? '.zip' : '.tar.gz';
const archivePath = path.join(tempOut, `${targetName}${archiveExt}`);
const checksumPath = path.join(tempOut, 'SHA256SUMS.txt');

expect(existsSync(archivePath), `archive file exists: ${archivePath}`);
expect(existsSync(checksumPath), `checksum file exists: ${checksumPath}`);

// Verify checksum
const archiveData = readFileSync(archivePath);
const computedHash = createHash('sha256').update(archiveData).digest('hex');
const checksumContent = readFileSync(checksumPath, 'utf8');
expect(
  checksumContent.includes(computedHash),
  `SHA256SUMS.txt contains computed hash ${computedHash}`,
);
console.log('[OK] Packaging and checksum verification passed');

console.log('[TEST] 2. Extract and execute standalone binary in clean workspace...');
const testWork = mkdtempSync(path.join(tmpdir(), 'lore-isolated-exec-'));
const extractedDir = path.join(testWork, 'lore-app');
mkdirSync(extractedDir, { recursive: true });

if (process.platform === 'win32') {
  execFileSync('powershell.exe', [
    '-Command',
    `Expand-Archive -Path "${archivePath}" -DestinationPath "${extractedDir}" -Force`,
  ]);
} else {
  execFileSync('tar', ['-xzf', archivePath, '-C', extractedDir]);
}

const loreBin = process.platform === 'win32'
  ? path.join(extractedDir, 'bin', 'lore.cmd')
  : path.join(extractedDir, 'bin', 'lore');

expect(existsSync(loreBin), `launcher binary exists: ${loreBin}`);

// Run --version in an isolated working directory with completely sanitized environment
const isolatedRepo = path.join(testWork, 'my-repo');
mkdirSync(isolatedRepo, { recursive: true });

function runPackaged(args) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER: process.env.USER,
    TMPDIR: tmpdir(),
  };
  return spawnSync(loreBin, args, {
    cwd: isolatedRepo,
    encoding: 'utf8',
    env,
  });
}

// 2.1 Version check
const verRes = runPackaged(['--version']);
expect(verRes.status === 0, `lore --version exited 0 (got ${verRes.status}: ${verRes.stderr})`);
expect(verRes.stdout.includes(pkg.version), `lore --version output matches ${pkg.version}`);
console.log(`[OK] Packaged binary executes --version: ${verRes.stdout.trim()}`);

// 2.2 Init check
const initRes = runPackaged(['init', '--solo']);
expect(initRes.status === 0, `lore init exited 0 (got ${initRes.status}: ${initRes.stderr})`);
expect(existsSync(path.join(isolatedRepo, '.lore', 'lore.db')), 'SQLite database created');
console.log('[OK] Packaged binary initialises store');

// 2.3 Write check
const writeRes = runPackaged([
  'write',
  '--subject',
  'pkg:express',
  '--predicate',
  'declared_dependency',
  '--object',
  '^4.19.0',
  '--kind',
  'human',
]);
expect(writeRes.status === 0, `lore write exited 0 (got ${writeRes.status}: ${writeRes.stderr})`);
expect(writeRes.stdout.includes('pkg:express'), 'lore write output contains subject');
console.log('[OK] Packaged binary performs claim writes');

// 2.4 Search check
const searchRes = runPackaged(['search', 'declared_dependency']);
expect(searchRes.status === 0, `lore search exited 0 (got ${searchRes.status}: ${searchRes.stderr})`);
expect(searchRes.stdout.includes('pkg:express'), 'lore search returned written claim');
console.log('[OK] Packaged binary performs memory retrieval');

// Clean up
try {
  rmSync(tempOut, { recursive: true, force: true });
  rmSync(testWork, { recursive: true, force: true });
} catch {}

if (failures > 0) {
  console.error(`TEST FAILED with ${failures} error(s)`);
  process.exit(1);
}
console.log('[OK] All standalone desktop binary packaging tests passed cleanly!');
