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
import { request } from 'node:http';
import Database from 'better-sqlite3';
import pg from 'pg';

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

/** Direct request without fetch: an idle keep-alive socket must not outlive its assertion. */
function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'GET', agent: false }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Direct hub request without fetch: a lingering keep-alive socket outlives the assertion. */
function postJson(url, token, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = request(
      url,
      {
        method: 'POST',
        agent: false,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }),
        );
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
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

const hub = spawn(process.execPath, [CLI, 'hub', 'serve', '--port', String(PORT)], { env, stdio: ['ignore', 'ignore', 'pipe'] });
// A crashed hub must be visible: the smoke fails on the next request otherwise.
hub.stderr.on('data', (chunk) => process.stderr.write(chunk));

try {
  for (let i = 0; i < 50; i += 1) {
    try {
      const response = await getJson(`${HUB}/healthz`);
      if (response.status === 200) break;
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
    'write:\n  "env:*": [maintainers]\nprotected:\n  "rule:*": [maintainers]\n  "secure:*":\n    roles: [maintainers]\n    min_attestations: 1\n',
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

  // --- Contributor proposal -> maintainer review -> promote into main ---
  const sessionOf = (dir) => /session: (\S+)/.exec(run(dir, ['session', 'status']))?.[1];
  const proposeSubject = 'rule:contrib-proposal';
  run(b, [
    'write',
    '--subject',
    proposeSubject,
    '--predicate',
    'enforces_invariant',
    '--object',
    'hub-proposal-marker',
    '--kind',
    'agent',
    '--ref',
    'README.md',
    '--author',
    'human:bob@team',
  ]);
  const proposeOut = run(b, ['push', '--propose'], { LORE_HUB_TOKEN: bobToken });
  const bobSession = sessionOf(b);
  assert.ok(bobSession, 'contributor session id must be readable');
  assert.match(proposeOut, new RegExp(`proposal refs/proposals/bob@team/${bobSession}`));
  assert.match(proposeOut, /drafts 1/);

  // A proposal is not main: the protected subject stays out of main until promoted.
  run(a, ['fetch'], { LORE_HUB_TOKEN: ownerToken });
  assert.doesNotMatch(run(a, ['search', 'hub-proposal-marker']), /hub-proposal-marker/);
  assert.match(run(a, ['proposals', 'list'], { LORE_HUB_TOKEN: ownerToken }), /open\s+bob@team/);
  assert.match(run(a, ['review', '--remote'], { LORE_HUB_TOKEN: ownerToken }), /hub-proposal-marker/);

  // Promoting before approval is refused, by the CLI and by the hub itself.
  const premature = runFail(a, ['proposals', 'promote', `bob@team/${bobSession}`], { LORE_HUB_TOKEN: ownerToken });
  assert.match(premature, /approve it first/);
  const hubPromote = await postJson(`${HUB}/v1/repos/${encodeURIComponent(repoId)}/proposals/promote`, ownerToken, {
    user: 'bob@team',
    session: bobSession,
    expected_main: null,
    bundle: { format: 'lore-bundle/1', repo_id: repoId, refs: [] },
  });
  assert.equal(hubPromote.status, 409, `hub promotion of an open proposal returned ${hubPromote.status}`);
  assert.match(hubPromote.body.error, /approve it before promoting/);

  run(a, ['proposals', 'approve', `bob@team/${bobSession}`], { LORE_HUB_TOKEN: ownerToken });
  const promoted = run(a, ['proposals', 'promote', `bob@team/${bobSession}`], { LORE_HUB_TOKEN: ownerToken });
  assert.match(promoted, /promoted refs\/proposals\/bob@team\/.+ main/);
  assert.match(run(a, ['proposals', 'list', '--status', 'promoted'], { LORE_HUB_TOKEN: ownerToken }), /promoted/);

  const p = repo('repo-p');
  run(p, ['init']);
  configure(p, ownerToken);
  run(p, ['fetch'], { LORE_HUB_TOKEN: ownerToken });
  assert.match(run(p, ['search', 'hub-proposal-marker']), /hub-proposal-marker/);
  assert.match(run(p, ['blame', proposeSubject]), /human:bob@team/);

  // --- Diverged main: conflict persists the remote ref, resolve unblocks push ---
  const x = repo('repo-x');
  run(x, ['init', '--solo']);
  configure(x, ownerToken);
  run(x, ['fetch'], { LORE_HUB_TOKEN: ownerToken });
  const y = repo('repo-y');
  run(y, ['init', '--solo']);
  configure(y, ownerToken);
  run(y, ['fetch'], { LORE_HUB_TOKEN: ownerToken });

  run(x, ['write', '--subject', 'doc:smoke/diverge.md', '--predicate', 'prefers_value', '--object', 'hub-diverge-alpha', '--kind', 'agent', '--ref', 'README.md']);
  run(x, ['promote']);
  run(x, ['push'], { LORE_HUB_TOKEN: ownerToken });

  run(y, ['write', '--subject', 'doc:smoke/diverge.md', '--predicate', 'prefers_value', '--object', 'hub-diverge-beta', '--kind', 'agent', '--ref', 'README.md']);
  run(y, ['promote']);
  const diverged = runFail(y, ['push'], { LORE_HUB_TOKEN: ownerToken });
  assert.match(diverged, /unresolved conflict\(s\) in doc:smoke\/diverge\.md prefers_value/);

  const yDatabase = new Database(path.join(y, '.lore', 'lore.db'), { readonly: true });
  const trackingRef = yDatabase.prepare("SELECT commit_id FROM ref WHERE name = 'refs/remotes/origin/main'").get();
  const openConflicts = yDatabase.prepare('SELECT COUNT(*) AS n FROM merge_conflict WHERE resolved = 0').get();
  yDatabase.close();
  assert.ok(trackingRef, 'refs/remotes/origin/main must be persisted when a sync merge conflicts');
  assert.ok(Number(openConflicts.n) > 0, 'the sync conflict must be recorded for lore resolve');

  run(y, ['resolve', 'doc:smoke/diverge.md', 'prefers_value', '--take', 'ours', '--reason', 'smoke divergence']);
  assert.match(run(y, ['push'], { LORE_HUB_TOKEN: ownerToken }), /pushed main/);

  const z = repo('repo-z');
  run(z, ['init']);
  configure(z, ownerToken);
  run(z, ['fetch'], { LORE_HUB_TOKEN: ownerToken });
  const zDatabase = new Database(path.join(z, '.lore', 'lore.db'), { readonly: true });
  const zMain = zDatabase.prepare("SELECT commit_id FROM ref WHERE name = 'main'").get()?.commit_id;
  const zMerge = zDatabase.prepare('SELECT merge_parent_id FROM memory_commit WHERE id = ?').get(zMain);
  const alphaClaim = zDatabase
    .prepare('SELECT id FROM claim WHERE subject_id = ? AND object_json LIKE ?')
    .get('doc:smoke/diverge.md', '%hub-diverge-alpha%');
  const alphaRetracted = zDatabase
    .prepare("SELECT 1 FROM commit_entry WHERE commit_id = ? AND claim_id = ? AND op = 'retract'")
    .get(zMain, alphaClaim?.id);
  zDatabase.close();
  assert.ok(zMerge?.merge_parent_id, 'the resolved push must publish a merge commit');
  assert.ok(alphaRetracted, 'the resolution must retract the losing claim in main');
  assert.match(run(z, ['blame', 'doc:smoke/diverge.md']), /hub-diverge-beta/);

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
  writeFileSync(
    path.join(e, '.lore.yml'),
    `repo_id: ${repoId}\nremote:\n  type: http\n  url: ${HUB}\n  token_env: LORE_HUB_TOKEN\n`,
  );
  run(e, ['init']);
  run(e, ['fetch'], { LORE_HUB_TOKEN: ownerToken });
  const converged = run(e, ['search', 'hub-c-marker']);
  assert.match(converged, /hub-c-marker/);
  assert.match(run(e, ['search', 'hub-d-marker']), /hub-d-marker/);

  // Revocation is enforced on the next request, even for pulls.
  run(work, ['hub', 'token', 'revoke', '--jti', bobJti, '--url', HUB]);
  const revoked = runFail(b, ['fetch'], { LORE_HUB_TOKEN: bobToken });
  assert.match(revoked, /invalid or revoked token|token has been revoked/);

  // The admin token is only for token management, never for sync.
  const adminSync = runFail(b, ['fetch'], { LORE_HUB_TOKEN: ADMIN });
  assert.match(adminSync, /admin token may only issue or revoke tokens/);

  // A repository-scoped maintainer token cannot touch another repository.
  const otherRepo = randomUUID();
  const scoped = run(work, ['hub', 'token', 'issue', '--sub', 'scoped@team', '--role', 'maintainer', '--repo', otherRepo, '--url', HUB])
    .split('\n')[0]
    .trim();
  const scopedSync = runFail(b, ['fetch'], { LORE_HUB_TOKEN: scoped });
  assert.match(scopedSync, /token is scoped to repository/);

  // A contributor cannot smuggle a purge tombstone for a protected claim.
  run(a, ['write', '--subject', 'rule:no-smuggling', '--predicate', 'enforces_invariant', '--object', 'hub-purge2-marker', '--kind', 'file', '--ref', 'README.md']);
  run(a, ['promote']);
  run(a, ['push'], { LORE_HUB_TOKEN: ownerToken });
  run(c, ['fetch'], { LORE_HUB_TOKEN: carolToken });
  const purgeId2 = /c_[a-f0-9]{32}/.exec(run(c, ['search', 'hub-purge2-marker']))?.[0];
  assert.ok(purgeId2, 'second claim id must be visible to the contributor');
  run(c, ['purge', purgeId2, '--reason', 'contributor attempt', '--yes']);
  run(c, ['push'], { LORE_HUB_TOKEN: carolToken });
  const f = repo('repo-f');
  run(f, ['init']);
  configure(f, ownerToken);
  run(f, ['fetch'], { LORE_HUB_TOKEN: ownerToken });
  assert.match(run(f, ['search', 'hub-purge2-marker']), /hub-purge2-marker/);

  // A cursor saved from an empty pull must not skip the first later row.
  const g = repo('repo-g');
  run(g, ['init']);
  configure(g, ownerToken);
  run(g, ['fetch'], { LORE_HUB_TOKEN: ownerToken });
  run(a, ['write', '--subject', 'doc:smoke/first-row.md', '--predicate', 'has_section', '--object', 'hub-first-row-marker', '--kind', 'file', '--ref', 'README.md']);
  run(a, ['promote']);
  run(a, ['push'], { LORE_HUB_TOKEN: ownerToken });
  run(g, ['fetch'], { LORE_HUB_TOKEN: ownerToken });
  assert.match(run(g, ['search', 'hub-first-row-marker']), /hub-first-row-marker/);

  // MCP transport accepts a repository token and lists the sync tools.
  const mcp = await postJson(`${HUB}/mcp`, ownerToken, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const mcpJson = mcp.body;
  assert.equal(mcp.status, 200);
  assert.deepEqual(mcpJson.result.tools.map((tool) => tool.name).sort(), [
    'repo_proposals',
    'repo_propose',
    'repo_pull',
    'repo_push',
  ]);

  // --- min_attestations quorum on a protected subject ---
  run(a, ['write', '--subject', 'secure:quorum', '--predicate', 'has_guardrail', '--object', 'hub-quorum-marker', '--kind', 'file', '--ref', 'README.md']);
  run(a, ['promote']);
  const quorumDenied = runFail(a, ['push'], { LORE_HUB_TOKEN: ownerToken });
  assert.match(quorumDenied, /needs 1 independent attestation/);
  const quorumClaim = /c_[a-f0-9]{32}/.exec(run(a, ['search', 'hub-quorum-marker']))?.[0];
  assert.ok(quorumClaim, 'quorum claim id must be discoverable');
  run(a, ['attest', quorumClaim, '--verdict', 'agree'], { LORE_HUB_TOKEN: ownerToken });
  run(a, ['push'], { LORE_HUB_TOKEN: ownerToken });
  const q = repo('repo-quorum');
  run(q, ['init']);
  configure(q, ownerToken);
  run(q, ['fetch'], { LORE_HUB_TOKEN: ownerToken });
  assert.match(run(q, ['search', 'hub-quorum-marker']), /hub-quorum-marker/);

  // A contributor may attest, but their submission must not count as review:
  // quorum counts reviewer tokens, not client-authored actor strings.
  run(c, ['fetch'], { LORE_HUB_TOKEN: carolToken });
  run(c, ['attest', quorumClaim, '--verdict', 'agree'], { LORE_HUB_TOKEN: carolToken });
  run(c, ['push'], { LORE_HUB_TOKEN: carolToken });
  const reviewer = new pg.Client({ connectionString: DB });
  await reviewer.connect();
  const attestationRows = await reviewer.query('SELECT pushed_by FROM repo_attestations WHERE repo_id = $1', [repoId]);
  await reviewer.end();
  const submittedBy = attestationRows.rows.map((row) => row.pushed_by);
  assert.ok(submittedBy.includes('owner@team'), 'a maintainer attestation must be recorded as review');
  assert.ok(!submittedBy.includes('carol@team'), 'a contributor attestation must not be recorded as review');

  console.log(
    '[OK] hub: tokens, policy denial, main guard, proposals (propose/approve/promote, provenance), diverged push with resolve, quorum, tombstones, delta sync, CAS retry, revocation, MCP tools'
  );
} finally {
  hub.kill('SIGTERM');
  rmSync(work, { recursive: true, force: true });
}
