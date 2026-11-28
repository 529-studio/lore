#!/usr/bin/env node
// Smoke test for `lore hub init` (0600 .env generation, Postgres schema init, and maintainer token minting).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
const DB = process.env.LORE_TEST_PG_URL ?? 'postgres://postgres:test@localhost:5432/postgres';
const work = mkdtempSync(path.join(tmpdir(), 'lore-hub-init-smoke-'));

function runLore(args, extraEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...extraEnv },
    encoding: 'utf8',
  });
}

try {
  // 1. Offline bootstrap: writes 0600 .env with generated secrets and refuses overwrite without --force.
  const outDir = path.join(work, 'deploy-env');
  const res = runLore(['hub', 'init', '--dir', outDir, '--domain', 'hub.lore.test', '--write-env', '--json']);
  assert.equal(res.status, 0, `lore hub init failed:\n${res.stdout}\n${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.domain, 'hub.lore.test');
  assert.equal(parsed.schema_initialized, false);
  assert.ok(parsed.admin_token && parsed.admin_token.length >= 32);
  assert.ok(parsed.postgres_password && parsed.postgres_password.length >= 32);

  const envPath = path.join(outDir, '.env');
  assert.equal(statSync(envPath).mode & 0o777, 0o600, '.env must have 0600 permissions');
  const envText = readFileSync(envPath, 'utf8');
  assert.match(envText, /LORE_HUB_DOMAIN=hub\.lore\.test/);
  assert.match(envText, new RegExp(`LORE_HUB_ADMIN_TOKEN=${parsed.admin_token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

  const conflict = runLore(['hub', 'init', '--dir', outDir, '--write-env']);
  assert.notEqual(conflict.status, 0, 'hub init --write-env must not overwrite existing .env without --force');

  // 2. With Postgres: initializes schema and mints initial maintainer token.
  const pgRes = runLore([
    'hub',
    'init',
    '--domain',
    'hub.lore.test',
    '--database-url',
    DB,
    '--maintainer',
    'alice@lore.test',
    '--json',
  ]);
  assert.equal(pgRes.status, 0, `lore hub init with PG failed:\n${pgRes.stdout}\n${pgRes.stderr}`);
  const pgParsed = JSON.parse(pgRes.stdout);
  assert.equal(pgParsed.schema_initialized, true);
  assert.ok(pgParsed.maintainer_token?.token, 'expected initial maintainer token');
  assert.equal(pgParsed.maintainer_token.role, 'maintainer');
  assert.equal(pgParsed.maintainer_token.sub, 'alice@lore.test');

  console.log('[OK] hub-init-smoke: 0600 .env bootstrap, overwrite guard, Postgres schema init, and maintainer token');
} finally {
  rmSync(work, { recursive: true, force: true });
}
