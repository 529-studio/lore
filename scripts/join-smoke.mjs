#!/usr/bin/env node
// .lore.yml + lore join: a fresh clone adopts the shared repo id and fetches the
// team baseline; init never generates a conflicting id; credentials are rejected.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
const PUBLIC_CHECK = path.join(ROOT, 'scripts', 'check-public-safe.sh');
const work = mkdtempSync(path.join(tmpdir(), 'lore-join-smoke-'));

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

function loreFails(cwd, args, env = {}) {
  const run = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  assert.notEqual(run.status, 0, `lore ${args.join(' ')} should fail:\n${run.stdout}\n${run.stderr}`);
  return `${run.stdout}\n${run.stderr}`;
}

function configOf(cwd) {
  return JSON.parse(readFileSync(path.join(cwd, '.lore', 'config.json'), 'utf8'));
}

function writeManifest(cwd, repoId, remote) {
  writeFileSync(
    path.join(cwd, '.lore.yml'),
    `repo_id: ${repoId}\nteam_mode: false\nremote:\n  type: dir\n  path: ${remote}\n`,
    'utf8',
  );
}

try {
  const shared = path.join(work, 'shared');
  mkdirSync(shared, { recursive: true });

  // Origin repo: code, baseline on main, pushed to the shared directory.
  const origin = path.join(work, 'origin');
  mkdirSync(path.join(origin, 'src'), { recursive: true });
  writeFileSync(
    path.join(origin, 'package.json'),
    JSON.stringify({ name: 'join-app', dependencies: { express: '^4.19.0' } }, null, 2),
  );
  writeFileSync(path.join(origin, 'src', 'server.js'), "const express = require('express');\n");
  git(work, ['init', '-q', '-b', 'main', 'origin']);
  git(origin, ['config', 'user.email', 'smoke@lore.test']);
  git(origin, ['config', 'user.name', 'Lore Smoke']);
  lore(origin, ['init', '--full', '--solo']);
  const repoId = configOf(origin).repo_id;
  lore(origin, ['remote', shared]);
  lore(origin, ['push']);
  writeManifest(origin, repoId, '../shared');
  git(origin, ['add', '-A']);
  git(origin, ['commit', '-q', '-m', 'init + lore manifest']);
  console.log('[OK] origin baseline pushed and .lore.yml committed');

  // Fresh clone: one command attaches and serves the fetched claims.
  const clone = path.join(work, 'clone');
  execFileSync('git', ['clone', '-q', origin, clone]);
  assert.ok(!existsSync(path.join(clone, '.lore')), 'clone must start without a store');
  const joinOut = lore(clone, ['join']);
  assert.match(joinOut, /joined/);
  assert.match(joinOut, /fetched:/);
  assert.equal(configOf(clone).repo_id, repoId, 'join adopts the manifest repo id');
  assert.equal(configOf(clone).remote.type, 'dir', 'join adopts the manifest remote');
  assert.match(
    lore(clone, ['search', 'express'], { LORE_SESSION: 'antigravity' }),
    /pkg:express/,
    'agent session sees fetched claims immediately',
  );
  console.log('[OK] lore join attaches a fresh clone and fetches claims');

  // init inside a manifest repo adopts the committed id, never a random UUID.
  const initClone = path.join(work, 'init-clone');
  execFileSync('git', ['clone', '-q', origin, initClone]);
  lore(initClone, ['init', '--solo']);
  assert.equal(configOf(initClone).repo_id, repoId, 'init adopts the manifest repo id');
  assert.equal(configOf(initClone).remote.type, 'dir', 'init adopts the manifest remote');
  console.log('[OK] lore init preserves the manifest repo id');

  // --no-fetch configures without pulling.
  const noFetchClone = path.join(work, 'no-fetch-clone');
  execFileSync('git', ['clone', '-q', origin, noFetchClone]);
  const noFetchOut = lore(noFetchClone, ['join', '--no-fetch']);
  assert.match(noFetchOut, /--no-fetch/);
  assert.equal(configOf(noFetchClone).repo_id, repoId);
  console.log('[OK] lore join --no-fetch configures without pulling');

  // Wrong local store id is a hard error, not a silent fork.
  const mismatch = path.join(work, 'mismatch');
  mkdirSync(path.join(mismatch, '.lore'), { recursive: true });
  writeFileSync(
    path.join(mismatch, '.lore', 'config.json'),
    `${JSON.stringify({ repo_id: '00000000-0000-4000-8000-000000000000' }, null, 2)}\n`,
  );
  writeManifest(mismatch, repoId, '../shared');
  assert.match(loreFails(mismatch, ['join']), /already belongs to/, 'mismatched store must fail closed');
  console.log('[OK] lore join refuses a store with a conflicting repo id');

  // Credentials in the committed manifest fail both join and check:public.
  const bad = path.join(work, 'bad-manifest');
  mkdirSync(bad, { recursive: true });
  git(bad, ['init', '-q', '-b', 'main']);
  git(bad, ['config', 'user.email', 'smoke@lore.test']);
  git(bad, ['config', 'user.name', 'Lore Smoke']);
  writeFileSync(
    path.join(bad, '.lore.yml'),
    `repo_id: ${repoId}\nremote:\n  type: postgres\n  url: postgres://user:pass@db.example.com/lore\n`,
    'utf8',
  );
  git(bad, ['add', '-A']);
  git(bad, ['commit', '-q', '-m', 'bad manifest']);
  assert.match(loreFails(bad, ['join']), /url_env/, 'raw postgres credentials must be rejected');
  const publicRun = spawnSync('bash', [PUBLIC_CHECK], { cwd: bad, encoding: 'utf8' });
  assert.notEqual(publicRun.status, 0, 'check:public must reject credentials in .lore.yml');
  assert.match(publicRun.stderr, /must not contain credentials/);
  console.log('[OK] raw credentials are rejected by join and check:public');

  // A password key is rejected even without a URL.
  const badKey = path.join(work, 'bad-key');
  mkdirSync(badKey, { recursive: true });
  writeFileSync(
    path.join(badKey, '.lore.yml'),
    `repo_id: ${repoId}\npassword: hunter2\n`,
    'utf8',
  );
  assert.match(loreFails(badKey, ['join']), /must not be committed/, 'secret keys must be rejected');
  console.log('[OK] secret keys are rejected from the manifest');

  // Absolute dir remotes leak machine layout.
  const badDir = path.join(work, 'bad-dir');
  mkdirSync(badDir, { recursive: true });
  writeFileSync(
    path.join(badDir, '.lore.yml'),
    `repo_id: ${repoId}\nremote:\n  type: dir\n  path: ${shared}\n`,
    'utf8',
  );
  assert.match(loreFails(badDir, ['join']), /relative path/, 'absolute dir remote must be rejected');
  console.log('[OK] absolute dir remotes are rejected from the manifest');

  // Unknown keys cannot smuggle credentials past validation.
  const badAuth = path.join(work, 'bad-auth');
  mkdirSync(badAuth, { recursive: true });
  writeFileSync(
    path.join(badAuth, '.lore.yml'),
    `repo_id: ${repoId}\nremote:\n  type: dir\n  path: ../shared\n  auth: "Bearer hunter2"\n`,
    'utf8',
  );
  assert.match(loreFails(badAuth, ['join']), /unknown remote key auth/, 'unknown remote keys must be rejected');
  const protoKey = path.join(work, 'proto-key');
  mkdirSync(protoKey, { recursive: true });
  writeFileSync(
    path.join(protoKey, '.lore.yml'),
    `repo_id: ${repoId}\nconstructor: "Bearer hunter2"\n`,
    'utf8',
  );
  assert.match(loreFails(protoKey, ['join']), /unknown key constructor/, 'prototype keys must not bypass the allowlist');
  console.log('[OK] unknown and prototype manifest keys are rejected');

  // check:public must also catch flow-style secret keys.
  const badFlow = path.join(work, 'bad-flow');
  mkdirSync(badFlow, { recursive: true });
  git(badFlow, ['init', '-q', '-b', 'main']);
  git(badFlow, ['config', 'user.email', 'smoke@lore.test']);
  git(badFlow, ['config', 'user.name', 'Lore Smoke']);
  writeFileSync(
    path.join(badFlow, '.lore.yml'),
    `repo_id: ${repoId}\nremote: {type: dir, path: ../shared, password: hunter2}\n`,
    'utf8',
  );
  git(badFlow, ['add', '-A']);
  git(badFlow, ['commit', '-q', '-m', 'flow-style secret']);
  const flowRun = spawnSync('bash', [PUBLIC_CHECK], { cwd: badFlow, encoding: 'utf8' });
  assert.notEqual(flowRun.status, 0, 'check:public must reject flow-style secret keys');
  assert.match(flowRun.stderr, /must not contain credentials/);
  console.log('[OK] flow-style secret keys are rejected');

  console.log('JOIN SMOKE OK — manifest adoption, one-command clone, no-fetch, mismatch and secret rejection');
} finally {
  rmSync(work, { recursive: true, force: true });
}
