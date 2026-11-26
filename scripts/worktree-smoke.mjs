#!/usr/bin/env node
// Linked-worktree smoke test: one shared store, isolated sessions, per-checkout
// file hashing, and concurrent worktrees on different commits.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { openDb, stateDirFor } from '../dist/db.js';
import { currentSession, branchFor } from '../dist/session.js';
import { head } from '../dist/model.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
const work = mkdtempSync(path.join(tmpdir(), 'lore-worktree-smoke-'));
const primary = path.join(work, 'primary');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function lore(cwd, args, env = {}) {
  return execFileSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
}

function loreAsync(cwd, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, out, err }));
  });
}

function claimId(output) {
  const id = output.match(/c_[a-f0-9]{32}/)?.[0];
  assert.ok(id, `no claim id in output: ${output}`);
  return id;
}

function mcpSearch(cwd, query) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'mcp'], {
      cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('MCP search timed out'));
    }, 15000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (const line of buffer.split('\n')) {
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 2) {
          clearTimeout(timer);
          child.kill();
          resolve(msg.result);
        }
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'wt-smoke', version: '1' } },
      })}\n`,
    );
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'memory_search', arguments: { query } },
      })}\n`,
    );
  });
}

try {
  mkdirSync(path.join(primary, 'src'), { recursive: true });
  git(work, ['init', '-q', '-b', 'main', 'primary']);
  git(primary, ['config', 'user.email', 'smoke@lore.test']);
  git(primary, ['config', 'user.name', 'Lore Smoke']);
  writeFileSync(path.join(primary, 'src', 'shared.js'), "export const value = 'A';\n");
  writeFileSync(path.join(primary, 'README.md'), '# worktree smoke\n');

  lore(primary, ['init', '--solo']);
  git(primary, ['add', '-A']);
  git(primary, ['commit', '-q', '-m', 'init']);

  const base = claimId(
    lore(primary, [
      'write',
      '--subject',
      'file:src/shared.js',
      '--predicate',
      'entrypoint',
      '--object',
      'shared',
      '--kind',
      'file',
      '--ref',
      'src/shared.js',
      '--author',
      'agent:base',
    ]),
  );
  lore(primary, ['promote']);
  assert.match(lore(primary, ['verify', base]), /valid/, 'primary checkout sees its own file');
  console.log('[OK] primary checkout verifies its own file');

  const wt1 = path.join(work, 'wt-one');
  const wt2 = path.join(work, 'wt-two');
  git(primary, ['worktree', 'add', '-q', '-b', 'wt-one', wt1]);
  git(primary, ['worktree', 'add', '-q', '-b', 'wt-two', wt2]);

  assert.ok(!existsSync(path.join(wt1, '.lore')), 'linked worktree must not create a local .lore');
  assert.ok(!existsSync(path.join(wt2, '.lore')), 'linked worktree must not create a local .lore');
  assert.ok(existsSync(path.join(primary, '.lore', 'lore.db')), 'shared store stays in the primary checkout');
  console.log('[OK] linked worktrees use the primary .lore');

  // status/search/write work immediately against the shared store.
  const status1 = lore(wt1, ['status']);
  assert.match(status1, /agent\/wt_/, 'worktree status must report a worktree session branch');
  assert.match(lore(wt1, ['search', 'shared']), /file:src\/shared\.js/, 'search reads the shared store');
  const wtClaim = claimId(
    lore(wt1, [
      'write',
      '--subject',
      'file:src/one.js',
      '--predicate',
      'entrypoint',
      '--object',
      'one',
      '--kind',
      'file',
      '--ref',
      'src/shared.js',
      '--author',
      'agent:wt-one',
    ]),
  );
  assert.ok(wtClaim);
  console.log('[OK] status, search and write work from a linked worktree');

  const db = openDb(primary);
  const s1 = currentSession(wt1);
  const s2 = currentSession(wt2);
  assert.notEqual(s1, s2, 'each worktree needs its own session');
  assert.match(s1, /^wt_/, 'worktree sessions are deterministic');
  assert.equal(s1, currentSession(wt1), 'worktree session must be stable across calls');
  assert.ok(head(db, branchFor(s1)), 'worktree write landed on its agent branch');
  console.log('[OK] worktrees get distinct stable agent branches');

  // MCP resolves the worktree root, session and shared store.
  const result = await mcpSearch(wt1, 'shared');
  assert.ok(result && !result.isError, 'MCP search must succeed from a worktree');
  const text = result.content?.map((part) => part.text ?? '').join('\n') ?? '';
  assert.match(text, /file:src\/shared\.js/, 'MCP search returns claims for the worktree');
  console.log('[OK] lore mcp works from a linked worktree');

  // Hashing must follow the caller's checkout, not the primary one.
  writeFileSync(path.join(wt1, 'src', 'shared.js'), "export const value = 'B';\n");
  assert.match(lore(wt1, ['verify', base]), /stale/, 'wt-one sees its modified file');
  assert.match(lore(wt2, ['verify', base]), /valid/, 'wt-two still sees the committed file');
  console.log('[OK] file hashing is evaluated per checkout');

  // Different commits, concurrent writes: SQLite stays usable.
  writeFileSync(path.join(wt1, 'only-one.txt'), 'one\n');
  git(wt1, ['add', 'only-one.txt']);
  git(wt1, ['commit', '-q', '-m', 'wt-one only']);
  const head1 = git(wt1, ['rev-parse', 'HEAD']);
  const head2 = git(wt2, ['rev-parse', 'HEAD']);
  assert.notEqual(head1, head2, 'worktrees must be on different commits');

  const [c1, c2] = await Promise.all([
    loreAsync(wt1, [
      'write',
      '--subject',
      'file:src/conc-one.js',
      '--predicate',
      'entrypoint',
      '--object',
      'c1',
      '--kind',
      'file',
      '--ref',
      'src/shared.js',
      '--author',
      'agent:conc-one',
    ]),
    loreAsync(wt2, [
      'write',
      '--subject',
      'file:src/conc-two.js',
      '--predicate',
      'entrypoint',
      '--object',
      'c2',
      '--kind',
      'file',
      '--ref',
      'src/shared.js',
      '--author',
      'agent:conc-two',
    ]),
  ]);
  assert.equal(c1.code, 0, `wt-one concurrent write failed: ${c1.err}`);
  assert.equal(c2.code, 0, `wt-two concurrent write failed: ${c2.err}`);
  assert.ok(head(db, branchFor(s1)) && head(db, branchFor(s2)), 'both concurrent writes committed');
  console.log('[OK] concurrent worktrees on different commits write to one store');

  db.close();

  // Opt-in isolation: a local config with worktree_mode=isolated keeps its own store.
  const wtIso = path.join(work, 'wt-iso');
  git(primary, ['worktree', 'add', '-q', '-b', 'wt-iso', wtIso]);
  mkdirSync(path.join(wtIso, '.lore'), { recursive: true });
  writeFileSync(
    path.join(wtIso, '.lore', 'config.json'),
    `${JSON.stringify({ repo_id: 'isolated-worktree', worktree_mode: 'isolated' }, null, 2)}\n`,
  );
  lore(wtIso, ['init', '--solo']);
  assert.ok(existsSync(path.join(wtIso, '.lore', 'lore.db')), 'isolated mode creates a local store');
  const primaryConfig = JSON.parse(readFileSync(path.join(primary, '.lore', 'config.json'), 'utf8'));
  const isoConfig = JSON.parse(readFileSync(path.join(wtIso, '.lore', 'config.json'), 'utf8'));
  assert.notEqual(primaryConfig.repo_id, isoConfig.repo_id, 'isolated worktrees keep a distinct repo id');
  console.log('[OK] worktree_mode=isolated opts out of the shared store');

  // git init --separate-git-dir uses a custom common directory name; the main
  // checkout is only discoverable via `git worktree list`.
  const sepPrimary = path.join(work, 'sep-primary');
  git(work, ['init', '-q', '--separate-git-dir', path.join(work, 'sep-git'), sepPrimary]);
  git(sepPrimary, ['config', 'user.email', 'smoke@lore.test']);
  git(sepPrimary, ['config', 'user.name', 'Lore Smoke']);
  writeFileSync(path.join(sepPrimary, 'README.md'), '# separate git dir\n');
  lore(sepPrimary, ['init', '--solo']);
  git(sepPrimary, ['add', '-A']);
  git(sepPrimary, ['commit', '-q', '-m', 'init']);
  const sepWt = path.join(work, 'sep-wt');
  git(sepPrimary, ['worktree', 'add', '-q', '-b', 'sep-wt', sepWt]);
  assert.throws(
    () => stateDirFor(sepWt),
    /LORE_STATE_DIR/,
    'an unresolvable primary must fail closed instead of forking the store',
  );
  assert.ok(!existsSync(path.join(sepWt, '.lore')), 'separate git dir worktree must not create a local .lore');
  const sepShared = { LORE_STATE_DIR: path.join(sepPrimary, '.lore') };
  assert.match(lore(sepWt, ['status'], sepShared), /agent\/wt_/, 'status works with an explicit state dir');
  console.log('[OK] separate-git-dir checkouts fail closed and honor LORE_STATE_DIR');

  console.log('WORKTREE SMOKE OK — shared store, isolated sessions, per-checkout hashing, concurrent commits');
} finally {
  rmSync(work, { recursive: true, force: true });
}
