#!/usr/bin/env node
// Dashboard smoke: start the read-only UI against a temp store and check the API.
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
}

lore(['init']);
lore(['ingest']);

const handle = await startUi(work, { port: 0 });
try {
  const home = await fetch(handle.url);
  const html = await home.text();
  if (!home.ok || !html.includes('Lore — memory health')) throw new Error('dashboard HTML missing');

  const health = await (await fetch(`${handle.url}/api/health`)).json();
  if (!health.active || health.active < 1) throw new Error(`health.active = ${health.active}`);
  if (typeof health.branch !== 'string' || !health.branch) throw new Error('health.branch missing');

  const claims = await (await fetch(`${handle.url}/api/claims?limit=10`)).json();
  if (!Array.isArray(claims) || claims.length < 1) throw new Error('claims endpoint returned nothing');
  if (!claims.every((c) => 'subject' in c && 'freshness' in c)) throw new Error('claim shape is wrong');

  const commits = await (await fetch(`${handle.url}/api/commits`)).json();
  if (!Array.isArray(commits) || commits.length < 1) throw new Error('commits endpoint returned nothing');

  const post = await fetch(`${handle.url}/api/claims`, { method: 'POST' });
  if (post.status !== 405) throw new Error(`POST must be rejected, got ${post.status}`);

  console.log(`[OK] ui: health ${health.active} active, ${claims.length} claims, read-only enforced`);
} finally {
  await handle.close();
}
