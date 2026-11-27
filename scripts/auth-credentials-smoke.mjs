#!/usr/bin/env node
// Smoke test for `lore auth login/status/logout` and per-hub credential resolution order.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
const work = mkdtempSync(path.join(tmpdir(), 'lore-auth-store-smoke-'));

function runLore(args, cwd, extraEnv = {}, input = undefined) {
  const env = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...extraEnv };
  return spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8', input });
}

try {
  const xdg = path.join(work, 'xdg');
  const repo = path.join(work, 'repo');
  mkdirSync(repo, { recursive: true });
  const repoId = '22222222-2222-4222-8222-222222222222';
  writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'auth-store-smoke' }), 'utf8');
  writeFileSync(
    path.join(repo, '.lore.yml'),
    [
      `repo_id: ${repoId}`,
      'remote:',
      '  type: http',
      '  url: https://hub.lore.test',
      '  token_env: LORE_HUB_TOKEN_AUTH_TEST',
      '',
    ].join('\n'),
    'utf8',
  );
  assert.equal(runLore(['init'], repo, { XDG_CONFIG_HOME: xdg }).status, 0);

  // 1. Login via --token-stdin stores credentials with 0600 permissions.
  const loginRes = runLore(
    ['auth', 'login', '--hub', 'https://hub.lore.test', '--token-stdin'],
    repo,
    { XDG_CONFIG_HOME: xdg },
    'lore_hub_secret_123456\n',
  );
  assert.equal(loginRes.status, 0, `auth login failed:\n${loginRes.stdout}\n${loginRes.stderr}`);
  const credFile = path.join(xdg, 'lore', 'credentials.json');
  const mode = statSync(credFile).mode & 0o777;
  assert.equal(mode, 0o600, `credentials.json must have 0600 permissions, got ${mode.toString(8)}`);

  // 2. Repo-scoped login also works and masks tokens in status output.
  const repoLogin = runLore(
    ['auth', 'login', '--hub', 'https://hub.lore.test', '--repo', repoId, '--token', 'lore_repo_secret_987654'],
    repo,
    { XDG_CONFIG_HOME: xdg },
  );
  assert.equal(repoLogin.status, 0, repoLogin.stderr);

  const statusRes = runLore(['auth', 'status', '--json'], repo, { XDG_CONFIG_HOME: xdg });
  assert.equal(statusRes.status, 0);
  assert.ok(!statusRes.stdout.includes('lore_hub_secret_123456'), 'status must mask hub token');
  assert.ok(!statusRes.stdout.includes('lore_repo_secret_987654'), 'status must mask repo token');
  const parsedStatus = JSON.parse(statusRes.stdout);
  assert.equal(parsedStatus.hubs.length, 1);
  assert.equal(parsedStatus.hubs[0].repos.length, 1);

  // 3. Doctor sees credentials.json and reports env.file [OK] even without token env var.
  const docRes = runLore(['doctor', '--json'], repo, { XDG_CONFIG_HOME: xdg });
  assert.equal(docRes.status, 0);
  const envCheck = JSON.parse(docRes.stdout).checks.find((c) => c.id === 'env.file');
  assert.equal(envCheck.status, 'ok', `doctor should accept credentials.json: ${JSON.stringify(envCheck)}`);
  assert.match(envCheck.message, /credentials\.json/);

  // 4. Verify token resolution precedence: process.env > env file > credentials.json (repo > hub).
  const httpMod = JSON.stringify(path.join(ROOT, 'dist', 'remotes', 'http.js'));
  const envMod = JSON.stringify(path.join(ROOT, 'dist', 'env.js'));
  const loreDir = path.join(xdg, 'lore');
  writeFileSync(path.join(loreDir, 'env'), 'LORE_HUB_TOKEN_AUTH_TEST=from-env-file\n', 'utf8');

  const checkPrecedence = (extraEnv) => {
    const res = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { loadLoreEnv } from ${envMod};
         import { hubToken } from ${httpMod};
         loadLoreEnv();
         console.log(hubToken({ type: 'http', url: 'https://hub.lore.test', token_env: 'LORE_HUB_TOKEN_AUTH_TEST' }, ${JSON.stringify(repoId)}));`,
      ],
      { cwd: repo, env: { ...process.env, XDG_CONFIG_HOME: xdg, ...extraEnv }, encoding: 'utf8' },
    );
    assert.equal(res.status, 0, res.stderr);
    return res.stdout.trim();
  };

  assert.equal(checkPrecedence({ LORE_HUB_TOKEN_AUTH_TEST: 'from-process-env' }), 'from-process-env');
  assert.equal(checkPrecedence({}), 'from-env-file');
  rmSync(path.join(loreDir, 'env'));
  assert.equal(checkPrecedence({}), 'lore_repo_secret_987654');

  // 5. Logout repo-scoped falls back to hub-level token, then logout hub removes it.
  assert.equal(runLore(['auth', 'logout', '--hub', 'https://hub.lore.test', '--repo', repoId], repo, { XDG_CONFIG_HOME: xdg }).status, 0);
  assert.equal(checkPrecedence({}), 'lore_hub_secret_123456');
  assert.equal(runLore(['auth', 'logout', '--hub', 'https://hub.lore.test'], repo, { XDG_CONFIG_HOME: xdg }).status, 0);

  const afterLogout = runLore(['auth', 'status', '--json'], repo, { XDG_CONFIG_HOME: xdg });
  assert.equal(JSON.parse(afterLogout.stdout).hubs.length, 0);

  console.log('[OK] auth-credentials-smoke: login, 0600 store, masked status, precedence, doctor, and logout');
} finally {
  rmSync(work, { recursive: true, force: true });
}
