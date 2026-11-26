#!/usr/bin/env node
// Cross-repo memory smoke (issue #197): a private infra repo publishes an
// allowlist through lore-hub; a consumer app repo subscribes with links:, gets
// ext:<origin>/ namespaced [EXT] claims, no doc:AGENTS.md collision, a capped
// external token share, and denied subjects never leave the hub.
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
const work = mkdtempSync(path.join(tmpdir(), 'lore-cross-repo-smoke-'));
const DB = process.env.LORE_TEST_PG_URL ?? 'postgres://postgres:test@localhost:5432/postgres';
const ADMIN = 'cross-repo-admin-token';
const PORT = 19000 + Math.floor(Math.random() * 500);
const HUB = `http://127.0.0.1:${PORT}`;
const suffix = randomUUID().slice(0, 8);
// `.lore.yml` repo_id is the hub identity (a UUID); `links:` maps the
// human-facing slug to it so claims namespace as ext:infra-repo-<suffix>/...
const INFRA = `infra-repo-${suffix}`;
const APP = `app-repo-${suffix}`;
const OTHER = `other-repo-${suffix}`;
const INFRA_ID = randomUUID();
const APP_ID = randomUUID();
const OTHER_ID = randomUUID();
const env = {
  ...process.env,
  NO_COLOR: '1',
  FORCE_COLOR: '0',
  LORE_HUB_DATABASE_URL: DB,
  LORE_HUB_ADMIN_TOKEN: ADMIN,
  LORE_HUB_ALLOW_INSECURE: '1',
};

const ok = (message) => console.log(`[OK] ${message}`);

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

function git(cwd, args) {
  spawnSync('git', args, { cwd, encoding: 'utf8' });
}

function makeRepo(name, repoId, policy) {
  const dir = path.join(work, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'cross-repo@lore.test']);
  git(dir, ['config', 'user.name', 'Cross Repo Smoke']);
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name }));
  writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
  writeFileSync(path.join(dir, '.lore.yml'), `repo_id: ${repoId}\n`);
  if (policy) writeFileSync(path.join(dir, 'lore.policy.yml'), policy);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'baseline']);
  return dir;
}

function issueToken(sub, role, repo) {
  const args = ['hub', 'token', 'issue', '--sub', sub, '--role', role, '--url', HUB];
  if (repo) args.push('--repo', repo);
  return run(work, args).split('\n')[0].trim();
}

/** Minimal stdio MCP client: one tools/call on a fresh `lore mcp` process. */
function mcpSearch(cwd, tokenEnv, query) {
  return new Promise((resolve, reject) => {
    const server = spawn(process.execPath, [CLI, 'mcp'], { cwd, env: { ...env, ...tokenEnv } });
    const pending = new Map();
    let buffer = '';
    const timer = setTimeout(() => {
      server.kill();
      reject(new Error('MCP memory_search timed out'));
    }, 15000);
    server.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        const waiter = pending.get(message.id);
        if (waiter) {
          pending.delete(message.id);
          waiter(message);
        }
      }
    });
    server.stderr.on('data', () => {});
    const send = (id, method, params) => {
      server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    };
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    send(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
    send(2, 'tools/call', { name: 'memory_search', arguments: { query, include_external: true } });
    pending.set(2, (message) => {
      clearTimeout(timer);
      server.kill();
      resolve(message);
    });
  });
}

const hub = spawn(process.execPath, [CLI, 'hub', 'serve', '--port', String(PORT)], {
  env,
  stdio: ['ignore', 'ignore', 'pipe'],
});
hub.stderr.on('data', (chunk) => process.stderr.write(chunk));

try {
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await getJson(`${HUB}/healthz`)).status === 200) break;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (i === 59) throw new Error('lore-hub did not start');
  }

  const infraToken = issueToken('infra-owner@team', 'maintainer', INFRA_ID);
  const appToken = issueToken('app-dev@team', 'contributor', APP_ID);
  const otherToken = issueToken('other-dev@team', 'contributor', OTHER_ID);
  // No --repo: a team-wide token must not bypass the publish policy via /pull.
  const unscopedToken = issueToken('roaming-dev@team', 'contributor');

  // --- private origin: allowlist publication, deny secrets/env --------------
  const infraPolicy = `publish:
  default_scope: internal
  allow:
    - "doc:*"
    - "rule:*"
  deny:
    - "env:*"
    - "file:secrets/*"
  to_repos: ["${APP_ID}"]
  require_trust: canonical
`;
  const infra = makeRepo('infra', INFRA_ID, infraPolicy);
  run(infra, ['init']);
  run(infra, ['ingest']);
  run(infra, ['write', '--subject', 'doc:ARCHITECTURE.md', '--predicate', 'defines_rule', '--object', 'upstream-arch-marker: services talk over mTLS', '--kind', 'file', '--ref', 'README.md']);
  run(infra, ['write', '--subject', 'doc:AGENTS.md', '--predicate', 'defines_rule', '--object', 'infra-agents-shared: infra repo contract', '--kind', 'file', '--ref', 'README.md']);
  run(infra, ['write', '--subject', 'env:DATABASE_URL', '--predicate', 'read_by', '--object', 'infra-secret-env-marker', '--kind', 'file', '--ref', 'README.md']);
  mkdirSync(path.join(infra, 'secrets'), { recursive: true });
  writeFileSync(path.join(infra, 'secrets', 'prod.key'), 'not-a-real-key\n');
  run(infra, ['write', '--subject', 'file:secrets/prod.key', '--predicate', 'read_by', '--object', 'infra-secret-file-marker', '--kind', 'file', '--ref', 'secrets/prod.key']);
  run(infra, ['write', '--subject', 'file:package.json', '--predicate', 'has_section', '--object', 'infra-internal-package-marker', '--kind', 'file', '--ref', 'package.json']);
  for (let i = 0; i < 15; i += 1) {
    run(infra, [
      'write',
      '--subject',
      `rule:upstream-budget-${i}`,
      '--predicate',
      'enforces_invariant',
      '--object',
      `upstream budget marker ${i}: cross repository invariant text that is long enough to consume tokens`,
      '--kind',
      'file',
      '--ref',
      'README.md',
    ]);
  }
  run(infra, ['promote']);
  run(infra, ['remote', '--hub', HUB, '--token-env', 'LORE_HUB_TOKEN']);
  assert.match(run(infra, ['push'], { LORE_HUB_TOKEN: infraToken }), /pushed main/);
  ok('private origin pushed its allowlist policy and claims');

  // Export bridge is deterministic and applies the same publish decision.
  const exportA = run(infra, ['export', '--md', '--filter', 'publish']);
  const exportB = run(infra, ['export', '--md', '--filter', 'publish']);
  assert.equal(exportA, exportB, 'filtered export must be deterministic');
  assert.match(exportA, /upstream-arch-marker/);
  assert.match(exportA, /infra-agents-shared/);
  assert.doesNotMatch(exportA, /infra-secret-env-marker|infra-secret-file-marker|infra-internal-package-marker/);
  ok('export --md --filter publish emits allowlisted markdown only');

  // --- hub payload inspection: denied rows never leave ----------------------
  const external = await postJson(`${HUB}/v1/repos/${encodeURIComponent(INFRA_ID)}/external`, appToken, {});
  assert.equal(external.status, 200, `external pull returned ${external.status}`);
  const subjects = external.body.bundle.claims.map((claim) => String(claim.subject_id));
  assert.ok(subjects.includes('doc:ARCHITECTURE.md'));
  assert.ok(subjects.includes('doc:AGENTS.md'));
  assert.ok(subjects.every((subject) => !subject.startsWith('env:')));
  assert.ok(subjects.every((subject) => !subject.startsWith('file:secrets/')));
  assert.ok(!subjects.includes('file:package.json'));
  ok(`hub external payload carries ${subjects.length} allowlisted claims and no denied subject`);

  const forbidden = await postJson(`${HUB}/v1/repos/${encodeURIComponent(INFRA_ID)}/external`, otherToken, {});
  assert.equal(forbidden.status, 403, `unauthorized repo pull returned ${forbidden.status}`);
  const unscopedPull = await postJson(`${HUB}/v1/repos/${encodeURIComponent(INFRA_ID)}/pull`, unscopedToken, {});
  assert.equal(unscopedPull.status, 403, `unscoped pull returned ${unscopedPull.status}`);
  const ownerPull = await postJson(`${HUB}/v1/repos/${encodeURIComponent(INFRA_ID)}/pull`, infraToken, {});
  assert.equal(ownerPull.status, 200, `owner pull returned ${ownerPull.status}`);
  ok('unauthorized repository and unscoped token receive 403; owner pull still works');

  // --- consumer: links subscription, ext namespace, no collision ------------
  const appPolicy = `links:\n  ${INFRA}:\n    repo_id: "${INFRA_ID}"\n`;
  const app = makeRepo('app', APP_ID, appPolicy);
  run(app, ['init']);
  run(app, ['write', '--subject', 'doc:AGENTS.md', '--predicate', 'defines_rule', '--object', 'app-local-agents: local contract', '--kind', 'file', '--ref', 'README.md']);
  run(app, ['write', '--subject', 'rule:local-budget', '--predicate', 'enforces_invariant', '--object', 'upstream budget local marker: local rule wins', '--kind', 'file', '--ref', 'README.md']);
  run(app, ['promote']);
  run(app, ['remote', '--hub', HUB, '--token-env', 'LORE_HUB_TOKEN']);
  const fetched = run(app, ['fetch'], { LORE_HUB_TOKEN: appToken });
  assert.match(fetched, /linked ext:/);
  ok('consumer fetch cached linked external memory');

  const appDb = new Database(path.join(app, '.lore', 'lore.db'), { readonly: true });
  const localAgents = appDb.prepare("SELECT id, origin_repo_id FROM claim WHERE subject_id = 'doc:AGENTS.md'").all();
  const externalAgents = appDb
    .prepare('SELECT id, origin_repo_id FROM claim WHERE subject_id = ?')
    .all(`ext:${INFRA}/doc:AGENTS.md`);
  const conflicts = appDb.prepare('SELECT COUNT(*) AS n FROM claim_conflict').get();
  const externalRows = appDb
    .prepare('SELECT COUNT(*) AS n FROM claim WHERE origin_repo_id = ?')
    .get(INFRA);
  appDb.close();
  assert.equal(localAgents.length, 1, 'the local doc:AGENTS.md claim must stay unique');
  assert.equal(localAgents[0].origin_repo_id, null);
  assert.equal(externalAgents.length, 1, 'the foreign claim must live under ext:<origin>/');
  assert.equal(externalAgents[0].origin_repo_id, INFRA);
  assert.equal(Number(conflicts.n), 0, 'foreign claims must not create tier-1 conflicts');
  assert.ok(Number(externalRows.n) > 0);
  ok('ext namespace prevents subject and factKey collisions');

  const extBlame = run(app, ['blame', `ext:${INFRA}/doc:AGENTS.md`]);
  assert.match(extBlame, /\[EXT\]/);
  assert.match(extBlame, new RegExp(INFRA));
  ok('blame renders [EXT] with the origin repository');

  const extSearch = run(app, ['search', 'infra-arch-marker']);
  assert.match(extSearch, /\[EXT\]/);
  assert.match(extSearch, /upstream-arch-marker/);
  assert.doesNotMatch(extSearch, /infra-secret-env-marker|infra-secret-file-marker/);
  ok('lore search renders subscribed ext claims as [EXT]');

  const localSearch = run(app, ['search', 'app-local-agents']);
  const localTop = localSearch.split('\n').find((line) => line.trimStart().startsWith('[1]')) ?? '';
  assert.match(localTop, /doc:AGENTS\.md/);
  assert.match(localTop, /app-local-agents/);
  assert.doesNotMatch(localTop, /\[EXT\]/);
  ok('local doc:AGENTS.md ranks first and keeps its local provenance');

  const writeExternal = runFail(app, [
    'write',
    '--subject',
    `ext:${INFRA}/doc:ARCHITECTURE.md`,
    '--predicate',
    'defines_rule',
    '--object',
    'consumer rewrite',
    '--kind',
    'file',
    '--ref',
    'README.md',
  ]);
  assert.match(writeExternal, /external claims are read-only/);
  ok('external claims reject memory_write targets');

  // --- external token share is capped ---------------------------------------
  const budget = 400;
  const searchJson = JSON.parse(run(app, ['search', 'upstream-budget', '--budget', String(budget), '--json']));
  const approx = (hit) =>
    Math.ceil(`${hit.subject} ${hit.predicate} ${hit.object} ${hit.reasons.join(' ')} `.length / 4);
  const externalHits = searchJson.hits.filter((hit) => hit.external);
  const externalTokens = externalHits.reduce((sum, hit) => sum + approx(hit), 0);
  assert.ok(externalHits.length > 0, 'at least one external claim must fit the capped share');
  assert.ok(externalHits.length < 15, 'the external share must not admit every upstream claim');
  assert.ok(externalTokens <= Math.floor(budget * 0.25), `external tokens ${externalTokens} exceed 25% of ${budget}`);
  assert.equal(searchJson.hits[0].external, false, 'local memory must be ranked before external memory');
  ok(`external budget cap holds (${externalTokens} <= ${Math.floor(budget * 0.25)} tokens, ${externalHits.length} hits)`);

  // --- MCP memory_search exposes the same [EXT] provenance ------------------
  const mcp = await mcpSearch(app, { LORE_HUB_TOKEN: appToken }, 'infra-arch-marker');
  const mcpText = mcp.result?.content?.map((part) => part.text ?? '').join('\n') ?? '';
  const mcpHits = mcp.result?.structuredContent?.hits ?? [];
  assert.match(mcpText, /\[EXT\]/, 'memory_search text must render [EXT]');
  assert.ok(mcpHits.some((hit) => hit.external === true && hit.origin_repo_id === INFRA));
  ok('MCP memory_search returns [EXT] hits with origin attribution');

  console.log('[OK] cross-repo smoke passed');
} finally {
  hub.kill();
  rmSync(work, { recursive: true, force: true });
}
