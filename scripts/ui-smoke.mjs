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
const pageHtml = await (await fetch(handle.url)).text();
const token = pageHtml.match(/const CSRF = '([^']+)'/)?.[1];
if (!token) throw new Error('CSRF token not found in the page');

// Verify client-side JavaScript syntax
const scriptMatch = pageHtml.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) throw new Error('No script tag found in UI HTML');
const vm = await import('node:vm');
try {
  new vm.Script(scriptMatch[1]);
} catch (err) {
  throw new Error(`client-side UI script syntax error: ${err.message}`);
}

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

  // Test entities endpoint
  const entities = await (await fetch(`${handle.url}/api/entities`)).json();
  if (!Array.isArray(entities) || entities.length === 0) throw new Error('entities endpoint returned no entities');
  const sampleEntity = entities[0];
  if (!sampleEntity.id || !sampleEntity.type || !sampleEntity.label) throw new Error('entity object missing required fields');

  // Test HTML page has memory authoring and dossier components
  const pageHtml = await (await fetch(handle.url)).text();
  if (!pageHtml.includes('modal-type-selector') || !pageHtml.includes('modal-preview-box') || !pageHtml.includes('entity-suggestions')) {
    throw new Error('page missing memory authoring components');
  }
  if (!pageHtml.includes('id="view-dossier"') || !pageHtml.includes('id="dossier-view"')) {
    throw new Error('page missing dossier view components');
  }
  if (!pageHtml.includes('data-type="internal"') || !pageHtml.includes('shortLabel')) {
    throw new Error('page missing graph layout enhancements');
  }
  if (!pageHtml.includes('id="graph-predicate-select"') || !pageHtml.includes('id="graph-cluster-mode"')) {
    throw new Error('page missing graph predicate filter or cluster mode controls');
  }
  if (!pageHtml.includes('id="arrow-imports"') || !pageHtml.includes('id="arrow-read"')) {
    throw new Error('page missing SVG directional arrow markers');
  }
  if (!pageHtml.includes('id="live-indicator"') || !pageHtml.includes('live-indicator')) {
    throw new Error('page missing live indicator component');
  }

  // Test Server-Sent Events (SSE) streaming endpoint
  const eventsUrl = `${handle.url}/api/events`;
  const eventRes = await fetch(eventsUrl);
  if (!eventRes.ok || !eventRes.headers.get('content-type')?.includes('text/event-stream')) {
    throw new Error(`SSE endpoint failed: status ${eventRes.status}, content-type: ${eventRes.headers.get('content-type')}`);
  }
  const reader = eventRes.body.getReader();
  const decoder = new TextDecoder();
  let initialChunk = '';
  while (!initialChunk.includes('event: connected')) {
    const { value, done } = await reader.read();
    if (done) break;
    initialChunk += decoder.decode(value, { stream: true });
  }
  if (!initialChunk.includes('event: connected') || !initialChunk.includes('"status":"connected"')) {
    throw new Error(`SSE initial event mismatch: ${initialChunk}`);
  }

  // Trigger a claim write and assert broadcast receipt on the open SSE stream
  const sseClaimPromise = (async () => {
    let sseChunk = '';
    while (!sseChunk.includes('event: claim:written')) {
      const { value, done } = await reader.read();
      if (done) break;
      sseChunk += decoder.decode(value, { stream: true });
    }
    return sseChunk;
  })();

  const sseCreated = await write('/api/claim', { subject: 'doc:sse.md', predicate: 'title', object: 'SSE Guide' });
  if (!sseCreated.ok) throw new Error('write for SSE test failed');

  const sseReceived = await Promise.race([
    sseClaimPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout waiting for SSE broadcast')), 4000)),
  ]);
  if (!sseReceived.includes('event: claim:written') || !sseReceived.includes('doc:sse.md')) {
    throw new Error(`SSE broadcast event mismatch: ${sseReceived}`);
  }
  await reader.cancel();

  // Test creating new claim via UI
  const created = await write('/api/claim', { subject: 'doc:ui.md', predicate: 'title', object: 'UI Guide' });
  if (!created.ok) throw new Error(`create claim failed: ${created.status}`);
  const createdJson = await created.json();
  if (!createdJson.id) throw new Error('created claim has no id');

  const createdRule = await write('/api/claim', { subject: 'rule:auth-check', predicate: 'enforces_invariant', object: 'Require bearer token on all private APIs' });
  if (!createdRule.ok) throw new Error(`create rule claim failed: ${createdRule.status}`);

  // Test superseding claim via UI
  const superseded = await write('/api/supersede', { claim: createdJson.id, object: 'Updated UI Guide' });
  if (!superseded.ok) throw new Error(`supersede failed: ${superseded.status}`);
  const supersededJson = await superseded.json();
  if (!supersededJson.newId) throw new Error('supersede returned no newId');

  // Test claim details & snippet inspector endpoint
  const details = await (await fetch(`${handle.url}/api/claim-details?id=${supersededJson.newId}`)).json();
  if (!details.id || !details.human_summary) throw new Error('claim-details endpoint missing summary');

  // Test favicon endpoints
  const favSvg = await fetch(`${handle.url}/favicon.svg`);
  if (!favSvg.ok || favSvg.headers.get('content-type') !== 'image/svg+xml') throw new Error('favicon.svg failed');
  const favIco = await fetch(`${handle.url}/favicon.ico`);
  if (!favIco.ok) throw new Error('favicon.ico failed');
  const favPng = await fetch(`${handle.url}/favicon.png`);
  if (!favPng.ok || favPng.headers.get('content-type') !== 'image/png') throw new Error('favicon.png failed');

  // Test repo indicator & repo switch endpoint
  if (!health.repo?.path || !health.repo?.name) throw new Error('health endpoint missing repo info');
  const work2 = mkdtempSync(path.join(tmpdir(), 'lore-ui-switch-'));
  const switched = await write('/api/repo/switch', { path: work2 });
  if (!switched.ok) throw new Error(`repo switch failed: ${switched.status}`);
  const switchedHealth = await (await fetch(`${handle.url}/api/health`)).json();
  if (switchedHealth.repo?.path !== work2) throw new Error(`switched health path mismatch: ${switchedHealth.repo?.path} !== ${work2}`);

  console.log('[OK] ui: read endpoints, CSRF, origin check, approve, reject, revert, claim, supersede, ontology, claim-details, favicons, repo-switch, sse-stream, graph-clustering');
} finally {
  await handle.close();
}
