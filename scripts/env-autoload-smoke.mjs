#!/usr/bin/env node
// Smoke test for ~/.config/lore/env ($XDG_CONFIG_HOME/lore/env) auto-loading and doctor reporting.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
const work = mkdtempSync(path.join(tmpdir(), 'lore-env-smoke-'));

function runLore(args, cwd, extraEnv = {}) {
  const env = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...extraEnv };
  return spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8' });
}

try {
  const xdg = path.join(work, 'xdg');
  const loreDir = path.join(xdg, 'lore');
  mkdirSync(loreDir, { recursive: true });
  const envFile = path.join(loreDir, 'env');

  writeFileSync(
    envFile,
    [
      '# comment line should be ignored',
      '',
      'export LORE_HUB_URL="https://hub.lore.test"',
      "LORE_HUB_TOKEN_DEMO='secret-from-env-file'",
      'export LORE_HUB_EXTRA=plain-value # inline comment',
      'NON_LORE_SHOULD_IGNORE=unsafe-value',
      '',
    ].join('\n'),
    'utf8',
  );

  const repo = path.join(work, 'repo');
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'env-smoke' }), 'utf8');
  writeFileSync(
    path.join(repo, '.lore.yml'),
    [
      'repo_id: 11111111-1111-4111-8111-111111111111',
      'remote:',
      '  type: http',
      '  url: https://hub.lore.test',
      '  token_env: LORE_HUB_TOKEN_DEMO',
      '',
    ].join('\n'),
    'utf8',
  );

  const cleanEnv = {
    XDG_CONFIG_HOME: xdg,
  };
  delete cleanEnv.LORE_HUB_TOKEN_DEMO;

  const initRes = runLore(['init'], repo, cleanEnv);
  assert.equal(initRes.status, 0, `lore init failed:\n${initRes.stdout}\n${initRes.stderr}`);

  // 1. Auto-loaded env satisfies http remote token check in doctor without explicit shell export.
  const docLoaded = runLore(['doctor', '--json'], repo, { XDG_CONFIG_HOME: xdg });
  assert.equal(docLoaded.status, 0, `lore doctor failed:\n${docLoaded.stdout}\n${docLoaded.stderr}`);
  const parsedLoaded = JSON.parse(docLoaded.stdout);
  const envCheck = parsedLoaded.checks.find((c) => c.id === 'env.file');
  assert.ok(envCheck, 'doctor output must include env.file check');
  assert.equal(envCheck.status, 'ok', `expected env.file ok, got: ${JSON.stringify(envCheck)}`);
  assert.match(envCheck.message, /loaded/);
  assert.ok(!docLoaded.stdout.includes('secret-from-env-file'), 'doctor output must never leak token values');

  // 2. Explicit process env wins over env file (including empty override).
  const docOverride = runLore(['doctor', '--json'], repo, {
    XDG_CONFIG_HOME: xdg,
    LORE_HUB_TOKEN_DEMO: '',
  });
  assert.equal(docOverride.status, 0);
  const overrideCheck = JSON.parse(docOverride.stdout).checks.find((c) => c.id === 'env.file');
  assert.equal(overrideCheck.status, 'warn', 'explicit empty process.env must not be overwritten by env file');
  assert.match(overrideCheck.message, /LORE_HUB_TOKEN_DEMO is unset/);

  // 3. Verify parsed values directly through node importing compiled dist/env.js.
  const probe = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { loadLoreEnv } from ${JSON.stringify(path.join(ROOT, 'dist', 'env.js'))};
       const res = loadLoreEnv();
       console.log(JSON.stringify({
         res,
         url: process.env.LORE_HUB_URL,
         tok: process.env.LORE_HUB_TOKEN_DEMO,
         extra: process.env.LORE_HUB_EXTRA,
         nonLore: process.env.NON_LORE_SHOULD_IGNORE ?? null,
       }));`,
    ],
    {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, XDG_CONFIG_HOME: xdg, LORE_HUB_EXTRA: 'from-process' },
    },
  );
  assert.equal(probe.status, 0, probe.stderr);
  const data = JSON.parse(probe.stdout);
  assert.equal(data.url, 'https://hub.lore.test');
  assert.equal(data.tok, 'secret-from-env-file');
  assert.equal(data.extra, 'from-process', 'explicit process env must win');
  assert.equal(data.nonLore, null, 'non-LORE_ keys must not be auto-loaded');
  assert.ok(data.res.loaded.includes('LORE_HUB_TOKEN_DEMO'));
  assert.ok(data.res.skipped.includes('LORE_HUB_EXTRA'));

  // 4. Missing env file with missing token warns cleanly in doctor.
  const emptyXdg = path.join(work, 'empty-xdg');
  const docMissing = runLore(['doctor', '--json'], repo, { XDG_CONFIG_HOME: emptyXdg });
  assert.equal(docMissing.status, 0);
  const missingCheck = JSON.parse(docMissing.stdout).checks.find((c) => c.id === 'env.file');
  assert.equal(missingCheck.status, 'warn');
  assert.match(missingCheck.message, /does not exist/);

  console.log('[OK] env-autoload-smoke: XDG env auto-load, precedence, non-LORE isolation, and doctor checks');
} finally {
  rmSync(work, { recursive: true, force: true });
}
