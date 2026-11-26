#!/usr/bin/env node
// Regression checks for issue #181:
//   1. `lore status` stale/branch reporting must not contradict itself.
//   2. A draft rewritten in an active session is not instantly "unreviewed for
//      3 sessions" just because its row was created earlier.
//   3. An exact multi-token rule outranks single-token boilerplate inside the
//      default 2,000-token search budget.
//
// Plain Node, no framework: same style as the other scripts/*-smoke.mjs files.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const LORE_BIN = path.join(SCRIPT_DIR, '..', 'dist', 'cli.js');

let failures = 0;

function fail(message) {
  failures += 1;
  console.error(`[ERR] ${message}`);
}

function ok(message) {
  console.log(`[OK] ${message}`);
}

function check(condition, message) {
  if (condition) ok(message);
  else fail(message);
}

function run(args, { cwd, env = {} } = {}) {
  const res = spawnSync(process.execPath, [LORE_BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function runOk(args, opts, label) {
  const res = run(args, opts);
  if (res.status !== 0) {
    fail(`${label}: exited ${res.status}\n${res.stderr || res.stdout}`);
  }
  return res;
}

function repo(name, { solo = true } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `lore-${name}-`));
  const git = (args) => {
    const res = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  };
  git(['init', '-q']);
  git(['config', 'user.email', 'smoke@example.com']);
  git(['config', 'user.name', 'Smoke']);
  writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  git(['add', '.']);
  git(['commit', '-qm', 'fixture']);
  runOk(solo ? ['init', '--solo'] : ['init'], { cwd: dir }, 'lore init');
  return dir;
}

// --- 1. status: branch scope, live drift vs persisted canon -----------------
{
  const dir = repo('status');
  writeFileSync(path.join(dir, 'src.ts'), 'export const value = 1;\n');
  runOk(['write', '--subject', 'file:src.ts', '--predicate', 'exports', '--object', 'value', '--kind', 'file', '--ref', 'src.ts'], { cwd: dir, env: { LORE_SESSION: 'owner' } }, 'write owner claim');

  const status = runOk(['status'], { cwd: dir, env: { LORE_SESSION: 'watcher' } }, 'status watcher').stdout;
  check(/in active set/.test(status), 'status reports a branch-scoped active set');
  check(/0 in active set/.test(status), 'status shows 0 active claims for an empty branch');
  check(/claims\s+\d+ total/.test(status), 'status shows store-wide totals');
  check(!/trust\s+[^\n]*\bstale\b/.test(status), 'status does not print a bare "0 stale" trust count');
  check(/persisted/.test(status), 'status labels canon trust as persisted state');

  writeFileSync(path.join(dir, 'src.ts'), 'export const value = 2;\n');
  const drifted = runOk(['status'], { cwd: dir, env: { LORE_SESSION: 'owner' } }, 'status drifted').stdout;
  const live = drifted.match(/stale\s+(\d+)\s*\(evidence hash/);
  check(Boolean(live) && Number(live[1]) > 0, 'status reports live evidence drift');
  check(!/trust\s+.*\bstale\b/.test(drifted), 'status trust summary no longer reprints a stale count');
}

// --- 2. GC: fresh/rewritten drafts are not stale ---------------------------
{
  const dir = repo('gc', { solo: false });
  const write = (session) =>
    runOk(
      ['write', '--subject', 'env:FRESH', '--predicate', 'read_by', '--object', 'README.md', '--kind', 'agent', '--author', 'agent:smoke'],
      { cwd: dir, env: { LORE_SESSION: session } },
      `write draft as ${session}`,
    ).stdout;

  write('s0');
  // Three later sessions make the old row genuinely eligible.
  for (const session of ['s1', 's2', 's3']) {
    runOk(['status'], { cwd: dir, env: { LORE_SESSION: session } }, `session ${session}`);
  }
  const aged = runOk(['gc', '--ttl-sessions', '3', '--dry-run'], { cwd: dir, env: { LORE_SESSION: 's3' } }, 'aged gc').stdout;
  check(aged.includes('env:FRESH'), 'an untouched draft is eligible after 3 later sessions');

  // Re-observing the same draft in the active session is new activity.
  write('s4');
  const fresh = runOk(['gc', '--ttl-sessions', '3', '--dry-run'], { cwd: dir, env: { LORE_SESSION: 's4' } }, 'fresh gc').stdout;
  check(!fresh.includes('env:FRESH'), 'a draft rewritten in an active session is not reported stale');
  const status = runOk(['status'], { cwd: dir, env: { LORE_SESSION: 's4' } }, 'status gc').stdout;
  check(/gc\s+0\s+drafts/.test(status), 'status does not count the fresh draft as unreviewed');
}

// --- 3. retrieval: exact multi-token phrase wins the budget ----------------
{
  const dir = repo('rank');
  writeFileSync(path.join(dir, 'telemetry.ts'), 'export const telemetry = true;\n');
  const env = { LORE_SESSION: 'rank' };

  let exactId = '';
  for (let i = 0; i < 57; i++) {
    const out = runOk(
      [
        'write',
        '--subject', `sym:telemetry.ts#probe${i}`,
        '--predicate', 'read_by',
        '--object', 'telemetry',
        '--kind', 'file',
        '--ref', 'telemetry.ts',
      ],
      { cwd: dir, env },
      `boilerplate claim ${i}`,
    ).stdout;
    const id = out.match(/c_[a-f0-9]{32}/)?.[0];
    if (!id) fail(`could not parse boilerplate claim id: ${out}`);
  }

  const exact = runOk(
    [
      'write',
      '--subject', 'rule:x-telemetry-key',
      '--predicate', 'enforces_invariant',
      '--object', 'Must send X-Telemetry-Key header on every request',
      '--kind', 'human',
      '--author', 'human:smoke',
    ],
    { cwd: dir, env },
    'write exact rule',
  ).stdout;
  exactId = exact.match(/c_[a-f0-9]{32}/)?.[0] ?? '';
  check(Boolean(exactId), 'exact rule was written');

  const json = runOk(['search', 'X-Telemetry-Key', '--json'], { cwd: dir, env }, 'search exact phrase').stdout;
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    fail(`search --json did not return JSON: ${json.slice(0, 200)}`);
  }
  if (parsed) {
    const hits = parsed.hits ?? [];
    const rank = hits.findIndex((h) => h.id === exactId);
    check(hits.length > 0, 'search returns hits inside the default 2000-token budget');
    check(rank >= 0, `exact rule ${exactId} appears within the default 2000-token budget`);
    check(rank >= 0 && rank < 3, `exact rule ranks in the top 3 (got ${rank < 0 ? 'absent' : rank + 1})`);
    const firstBoilerplate = hits.findIndex((h) => h.id !== exactId && h.subject.startsWith('sym:telemetry.ts#'));
    check(rank >= 0 && (firstBoilerplate === -1 || rank < firstBoilerplate), 'exact rule outranks single-token boilerplate');
  }
}

if (failures) {
  console.error(`\nstatus-ranking smoke FAILED (${failures} check(s))`);
  process.exit(1);
}
console.log('status-ranking smoke OK — status consistency, draft GC distance, exact-phrase ranking');
