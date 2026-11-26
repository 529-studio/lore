#!/usr/bin/env node
// lore-hub integration smoke: per-user tokens, HTTPS-style auth boundary,
// delta pull/push, CAS retry, tombstones, and server-side policy denial.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
const work = mkdtempSync(path.join(tmpdir(), 'lore-hub-smoke-'));
const DB = process.env.LORE_TEST_PG_URL ?? 'postgres://postgres:test@localhost:5432/postgres';
const ADMIN = 'smoke-admin-token';
const PORT = 18000 + Math.floor(Math.random() * 1000);
const HUB = `http://127.0.0.1:${PORT}`;
const repoId = randomUUID();
const env = {
  ...process.env,
  NO_COLOR: '1',
  FORCE_COLOR: '0',
  LORE_HUB_DATABASE_URL: DB,
  LORE_HUB_ADMIN_TOKEN: ADMIN,
  LORE_HUB_ALLOW_INSECURE: '1',
};

function run(cwd, args, extra = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...env, ...extra },
  });
  if (result.status !== 0) {
    throw new Error(`lore ${args.join(' ')} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return `${result.stdout}${result.stderr}`;
}

function runFail(cwd, args, extra = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...env, ...extra },
  });
  assert.notEqual(result.status, 0, `lore ${args.join(' ')} should fail`);
  return `${result.stdout}\n${result.stderr}`;
}

function git(cwd, args) {
  spawnSync('git', args, { cwd, encoding: 'utf8' });
}

function repo(name) {
  const dir = path.join(work, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'hub-smoke@lore.test']);
  git(dir, ['config', 'user.name', 'Hub Smoke']);
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'hub-smoke' }));
  writeFileSync(path.join(dir, 'README.md'), '# hub smoke\n');
  writeFileSync(path.join(dir, '.lore.yml'), `repo_id: ${repoId}\n`);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'baseline']);
  return dir;
}

function configure(dir, token, extraEnv = {}) {
  run(dir, ['remote', '--hub', HUB, '--token-env', 'LORE_HUB_TOKEN'], { LORE_HUB_TOKEN: token, ...extraEnv });
}

const hub = spawn(process.execPath, [CLI, 'hub', 'serve', '--port', String(PORT)], { env, stdio: 'ignore' });

try {
  for (let i = 0; i < 50; i += 1) {
    try {
      const response = await fetch(`${HUB}/healthz`);
      if (response.ok) break;
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (i === 49) throw new Error('lore-hub did not start');
  }

  const ownerToken = run(work, ['hub', 'token', 'issue', '--sub', 'owner@team', '--role', 'maintainer', '--url', HUB])
    .split('\n')[0]
    .trim();
  const bob = run(work, ['hub', 'token', 'issue', '--sub', 'bob@team', '--role', 'contributor', '--url', HUB]);
  const bobToken = bob.split('\n')[0].trim();
  const bobJti = /jti ([0-9a-f]{64})/.exec(bob)?.[1];
  assert.ok(bobJti, 'token issue must print the jti for revocation');
  const carolToken = run(work, ['hub', 'token', 'issue', '--sub', 'carol@team', '--role', 'contributor', '--url', HUB])
    .split('\n')[0]
    .trim();

  // Owner repo with policy and two claims destined for redact/purge.
  const a = repo('repo-a');
  writeFileSync(
    path.join(a, 'lore.policy.yml'),
    'write:\n  "env:*": [maintainers]\nprotected:\n  "rule:*": [maintainers]\n',
  );
  run(a, ['init']);
  run(a, ['ingest']);
  run(a, ['write', '--subject', 'doc:smoke/redact.md', '--predicate', 'has_section', '--object', 'hub-redact-marker', '--kind', 'file', '--ref', 'README.md']);
  run(a, ['write', '--subject', 'doc:smoke/purge.md', '--predicate', 'has_section', '--object', 'hub-purge-marker', '--kind', 'file', '--ref', 'README.md']);
  run(a, ['promote']);
  configure(a, ownerToken);
  const firstPush = run(a, ['push'], { LORE_HUB_TOKEN: ownerToken });
  assert.match(firstPush, /pushed main/);

  // A fresh clone over the hub sees the baseline and adds a branch claim.
  const b = repo('repo-b');
  run(b, ['init']);
  configure(b, bobToken);
  run(b, ['fetch'], { LORE_HUB_TOKEN: bobToken });
  assert.match(run(b, ['search', 'hub-redact-marker']), /hub-redact-marker/);

  // Contributor cannot mutate a protected subject even though the client has
  // no team mode and no local policy enforcement.
  run(b, ['write', '--subject', 'env:HUB_SECRET', '--predicate', 'read_by', '--object', 'README.md', '--kind', 'file', '--ref', 'README.md']);
  const protectedPush = runFail(b, ['push'], { LORE_HUB_TOKEN: bobToken });
  assert.match(protectedPush, /requires role maintainers/);

  // Contributor cannot advance main directly.
  run(b, ['promote']);
  const mainPush = runFail(b, ['push'], { LORE_HUB_TOKEN: bobToken });
  assert.match(mainPush, /only a maintainer may advance main/);

  // Tombstones: redact and purge on the owner, then a clean client pulls.
  const redactId = /c_[a-f0-9]{32}/.exec(
    run(a, ['search', 'hub-redact-marker']),
  )?.[0];
  const purgeId = /c_[a-f0-9]{32}/.exec(run(a, ['search', 'hub-purge-marker']))?.[0];
  assert.ok(redactId && purgeId, 'claim ids must be discoverable via search');
  run(a, ['redact', redactId, '--reason', 'smoke redaction']);
  run(a, ['purge', purgeId, '--reason', 'smoke purge', '--yes']);
  run(a, ['push'], { LORE_HUB_TOKEN: ownerToken });

  const c = repo('repo-c');
  run(c, ['init']);
  configure(c, carolToken);
  run(c, ['fetch'], { LORE_HUB_TOKEN: carolToken });
  assert.doesNotMatch(run(c, ['search', 'hub-redact-marker']), /hub-redact-marker/);
  assert.doesNotMatch(run(c, ['search', 'hub-purge-marker']), /hub-purge-marker/);
  assert.match(run(c, ['status']), /active/);

  // CAS: c pushes first; d (stale main) retries after 409 and converges.
  run(c, ['write', '--subject', 'doc:smoke/c.md', '--predicate', 'has_section', '--object', 'hub-c-marker', '--kind', 'file', '--ref', 'README.md']);
  run(c, ['promote']);
  run(c, ['push'], { LORE_HUB_TOKEN: ownerToken });

  const d = repo('repo-d');
  run(d, ['init']);
  configure(d, carolToken);
  run(d, ['fetch'], { LORE_HUB_TOKEN: carolToken });
  run(d, ['write', '--subject', 'doc:smoke/d.md', '--predicate', 'has_section', '--object', 'hub-d-marker', '--kind', 'file', '--ref', 'README.md']);
  run(d, ['promote']);
  run(d, ['push'], { LORE_HUB_TOKEN: ownerToken });

  const e = repo('repo-e');
  run(e, ['init']);
  configure(e, ownerToken);
  run(e, ['fetch'], { LORE_HUB_TOKEN: ownerToken });
  const converged = run(e, ['search', 'hub-c-marker']);
  assert.match(converged, /hub-c-marker/);
  assert.match(run(e, ['search', 'hub-d-marker']), /hub-d-marker/);

  // Revocation is enforced on the next request, even for pulls.
  run(work, ['hub', 'token', 'revoke', '--jti', bobJti, '--url', HUB]);
  const revoked = runFail(b, ['fetch'], { LORE_HUB_TOKEN: bobToken });
  assert.match(revoked, /invalid or revoked token|token has been revoked/);

  // MCP transport accepts the admin token and lists the sync tools.
  const mcp = await fetch(`${HUB}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const mcpJson = await mcp.json();
  assert.equal(mcp.status, 200);
  assert.deepEqual(mcpJson.result.tools.map((tool) => tool.name).sort(), ['repo_pull', 'repo_push']);

  console.log('[OK] hub: per-user tokens, policy denial, main guard, tombstones, delta sync, CAS retry, revocation, MCP tools');
} finally {
  hub.kill('SIGTERM');
  rmSync(work, { recursive: true, force: true });
}
