#!/usr/bin/env node
// Postgres transport smoke: two independent stores, one shared database.
// Requires a reachable Postgres; set LORE_TEST_PG_URL or use the CI default.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
const URL = process.env.LORE_TEST_PG_URL ?? 'postgres://postgres:test@localhost:5432/postgres';

const work = mkdtempSync(path.join(tmpdir(), 'lore-pg-'));

function fail(message) {
  console.error(`[ERR] ${message}`);
  process.exit(1);
}

function run(cwd, args) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  if (result.status !== 0) fail(`lore ${args.join(' ')} exited ${result.status}: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function runAsync(cwd, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

function seed(dir, name) {
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name }));
  writeFileSync(path.join(dir, 'src', 'app.ts'), 'const flag = process.env.PG_FLAG;\nexport default flag;\n');
}

function gitInit(dir) {
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'pg@lore.local'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'pg'], { cwd: dir });
}

function commitAll(dir) {
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', ['commit', '-qm', 'baseline'], { cwd: dir });
}

// --- A: create and push ------------------------------------------------------
const A = path.join(work, 'a');
mkdirSync(A);
gitInit(A);
seed(A, 'pg-a');
commitAll(A);
run(A, ['init']);
run(A, ['ingest']);
run(A, ['promote']);
run(A, ['remote', '--postgres', URL]);
run(A, ['push']);

// --- B: independent store, same repository identity --------------------------
const B = path.join(work, 'b');
mkdirSync(B);
gitInit(B);
seed(B, 'pg-a');
commitAll(B);
mkdirSync(path.join(B, '.lore'));
copyFileSync(path.join(A, '.lore', 'config.json'), path.join(B, '.lore', 'config.json'));
run(B, ['init']);
run(B, ['remote', '--postgres', URL]);
run(B, ['fetch']);

const bSearch = run(B, ['search', 'PG_FLAG', '--files', 'src/app.ts', '--json']);
const bHits = JSON.parse(bSearch).hits ?? [];
if (!bHits.some((h) => h.subject === 'env:PG_FLAG')) fail('B did not receive A claims through postgres');

// --- B pushes a new fact, A fetches it ---------------------------------------
writeFileSync(path.join(B, 'src', 'b.ts'), 'const b = process.env.FROM_B;\n');
run(B, ['ingest']);
run(B, ['promote']);
run(B, ['push']);
run(A, ['fetch']);
const aSearch = run(A, ['search', 'FROM_B', '--files', 'src/b.ts', '--trust-remote', '--json']);
if (!(JSON.parse(aSearch).hits ?? []).some((h) => h.subject === 'env:FROM_B')) {
  fail('A did not receive B claims through postgres');
}

// --- concurrent pushes under the advisory lock -------------------------------
writeFileSync(path.join(A, 'src', 'a2.ts'), 'const a2 = process.env.FROM_A2;\n');
run(A, ['ingest']);
run(A, ['promote']);
writeFileSync(path.join(B, 'src', 'b2.ts'), 'const b2 = process.env.FROM_B2;\n');
run(B, ['ingest']);
run(B, ['promote']);

const [pushA, pushB] = await Promise.all([runAsync(A, ['push']), runAsync(B, ['push'])]);
if (pushA.code !== 0) fail(`concurrent push A failed: ${pushA.stderr || pushA.stdout}`);
if (pushB.code !== 0) fail(`concurrent push B failed: ${pushB.stderr || pushB.stdout}`);

run(A, ['fetch']);
run(B, ['fetch']);
for (const [dir, label] of [[A, 'A'], [B, 'B']]) {
  const found = run(dir, ['search', 'FROM_A2', '--files', 'src/a2.ts', '--trust-remote', '--json']);
  if (!(JSON.parse(found).hits ?? []).length) fail(`${label} lost FROM_A2 after concurrent pushes`);
  const foundB = run(dir, ['search', 'FROM_B2', '--files', 'src/b2.ts', '--trust-remote', '--json']);
  if (!(JSON.parse(foundB).hits ?? []).length) fail(`${label} lost FROM_B2 after concurrent pushes`);
}

console.log('[OK] postgres sync: two stores, bidirectional, concurrent pushes, no lost claims');
