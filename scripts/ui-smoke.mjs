#!/usr/bin/env node
// Dashboard smoke: read endpoints, write endpoints, CSRF and Origin enforcement.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startUi } from '../dist/ui/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
const work = mkdtempSync(path.join(tmpdir(), 'lore-ui-'));

mkdirSync(path.join(work, 'src'));
writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'ui-demo', scripts: { test: 'node t.js' } }));
writeFileSync(path.join(work, 'src', 'app.ts'), 'const url = process.env.UI_FLAG;\nexport default url;\n');
writeFileSync(path.join(work, 'README.md'), '# UI demo\n\n## Scope\n');

function lore(args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: work, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`lore ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

function claimId(stdout) {
  const match = stdout.match(/c_[0-9a-f]{8,}/);
  if (!match) throw new Error(`no claim id in: ${stdout}`);
  return match[0];
}

lore(['init']);
lore(['ingest']);
const draftA = claimId(lore(['write', '--subject', 'env:UI_A', '--predicate', 'read_by', '--object', 'README.md', '--kind', 'agent', '--author', 'agent:ui']));
const draftB = claimId(lore(['write', '--subject', 'env:UI_B', '--predicate', 'read_by', '--object', 'README.md', '--kind', 'agent', '--author', 'agent:ui']));

const handle = await startUi(work, { port: 0 });
const token = (await (await fetch(handle.url)).text()).match(/const CSRF = '([^']+)'/)?.[1];
if (!token) throw new Error('CSRF token not found in the page');

const write = (route, body, headers = {}) =>
  fetch(`${handle.url}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-lore-csrf': token, ...headers },
    body: JSON.stringify(body),
  });

try {
  const health = await (await fetch(`${handle.url}/api/health`)).json();
  if (!health.active || health.active < 1) throw new Error(`health.active = ${health.active}`);

  const claims = await (await fetch(`${handle.url}/api/claims?limit=10`)).json();
  if (!Array.isArray(claims) || claims.length < 1) throw new Error('claims endpoint returned nothing');

  const identity = await (await fetch(`${handle.url}/api/identity`)).json();
  if (!identity.principal) throw new Error('identity endpoint returned no principal');

  const noToken = await fetch(`${handle.url}/api/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: [draftA] }),
  });
  if (noToken.status !== 403) throw new Error(`write without CSRF must be 403, got ${noToken.status}`);

  const badOrigin = await write('/api/approve', { ids: [draftA] }, { origin: 'http://evil.example' });
  if (badOrigin.status !== 403) throw new Error(`cross-origin write must be 403, got ${badOrigin.status}`);

  const approved = await write('/api/approve', { ids: [draftA] });
  if (!approved.ok) throw new Error(`approve failed: ${approved.status}`);
  if (lore(['blame', 'env:UI_A']).includes('draft')) throw new Error('claim is still a draft after approve');

  const rejected = await write('/api/reject', { claim: draftB, reason: 'smoke' });
  if (!rejected.ok) throw new Error(`reject failed: ${rejected.status}`);
  if (!lore(['blame', 'env:UI_B']).includes('retracted')) throw new Error('claim is not retracted after reject');

  const commits = await (await fetch(`${handle.url}/api/commits`)).json();
  const approveCommit = commits.find((c) => c.message.startsWith('approve:'));
  if (!approveCommit) throw new Error('approve commit not found');

  const reverted = await write('/api/revert', { commit: approveCommit.id });
  if (!reverted.ok) throw new Error(`revert failed: ${reverted.status}`);
  const body = await reverted.json();
  if (!body.changed?.length) throw new Error('revert changed nothing');

  const post405 = await fetch(`${handle.url}/api/claims`, { method: 'POST' });
  if (post405.status !== 403) throw new Error(`unknown POST must be 403 (CSRF first), got ${post405.status}`);

  // Test ontology endpoint
  const ontology = await (await fetch(`${handle.url}/api/ontology`)).json();
  if (typeof ontology !== 'object' || ontology.exists === undefined) throw new Error('ontology endpoint failed');

  // Test creating new claim via UI
  const created = await write('/api/claim', { subject: 'doc:ui.md', predicate: 'title', object: 'UI Guide' });
  if (!created.ok) throw new Error(`create claim failed: ${created.status}`);
  const createdJson = await created.json();
  if (!createdJson.id) throw new Error('created claim has no id');

  // Test superseding claim via UI
  const superseded = await write('/api/supersede', { claim: createdJson.id, object: 'Updated UI Guide' });
  if (!superseded.ok) throw new Error(`supersede failed: ${superseded.status}`);
  const supersededJson = await superseded.json();
  if (!supersededJson.newId) throw new Error('supersede returned no newId');

  console.log('[OK] ui: read endpoints, CSRF, origin check, approve, reject, revert, claim, supersede, ontology');
} finally {
  await handle.close();
}
