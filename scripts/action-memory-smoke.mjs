#!/usr/bin/env node
// CI-path smoke: run the exact Python block the composite action uses to turn
// `lore status --json` / `lore diff --json` into a PR comment. Fixture-driven,
// deterministic, no network.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ACTION = path.join(ROOT, '.github', 'actions', 'lore', 'action.yml');
const work = mkdtempSync(path.join(tmpdir(), 'lore-action-smoke-'));

function extractPython(yaml) {
  const match = yaml.match(/<<'PY'\r?\n([\s\S]*?)\r?\n\s*PY\s*$/m);
  assert.ok(match, 'action.yml must embed a PY heredoc for the comment parser');
  const lines = match[1].split('\n');
  const indents = lines.filter((line) => line.trim()).map((line) => line.match(/^ */)[0].length);
  const strip = Math.min(...indents);
  return lines.map((line) => line.slice(Math.min(strip, line.length))).join('\n');
}

try {
  const yaml = readFileSync(ACTION, 'utf8');
  assert.match(yaml, /lore status --json/, 'the action must read status as JSON');
  assert.match(yaml, /lore diff main\.\.agent\/head --json/, 'the action must read the diff as JSON');
  assert.doesNotMatch(yaml, /stale\\s\+\(\\d\+\)/, 'the action must not scrape the human status text');

  const status = {
    branch: 'agent/head',
    stale: 3,
    stale_claims: [
      {
        id: 'c_team_human',
        subject: 'env:TEAM_TOKEN',
        predicate: 'read_by',
        author: 'human:alice',
        evidence: ['src/auth.ts'],
      },
      {
        id: 'c_team_agent',
        subject: 'sym:src/auth.ts#login',
        predicate: 'enforces_invariant',
        author: 'agent:mcp',
        evidence: ['src/auth.ts'],
      },
      {
        id: 'c_extracted',
        subject: 'file:src/auth.ts',
        predicate: 'imports_module',
        author: 'lore:ingest',
        evidence: ['src/auth.ts'],
      },
    ],
    ahead_claims: [],
  };
  const diff = {
    from: 'main',
    to: 'agent/head',
    added: [{ id: 'c_new', subject: 'file:src/new.ts', predicate: 'imports_module', object: 'zod' }],
    removed: [],
    unchanged: 4,
  };

  const statusPath = path.join(work, 'status.json');
  const diffPath = path.join(work, 'diff.json');
  const outPath = path.join(work, 'comment.md');
  const metricsPath = path.join(work, 'metrics.txt');
  writeFileSync(statusPath, JSON.stringify(status));
  writeFileSync(diffPath, JSON.stringify(diff));

  const python = extractPython(yaml);
  const run = spawnSync(
    'python3',
    ['-', statusPath, diffPath, outPath, metricsPath, '15'],
    { input: python, encoding: 'utf8' },
  );
  assert.equal(run.status, 0, `comment parser failed:\n${run.stderr}`);

  const comment = readFileSync(outPath, 'utf8');
  const metrics = Object.fromEntries(
    readFileSync(metricsPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split('=')),
  );

  assert.match(comment, /It invalidates \*\*3\*\* existing claim\(s\); \*\*2\*\* were taught by a teammate or agent/);
  assert.match(comment, /Invalidated team claims/);
  assert.match(comment, /c_team_human env:TEAM_TOKEN — read_by \(human:alice\)/);
  assert.match(comment, /c_team_agent sym:src\/auth\.ts#login — enforces_invariant \(agent:mcp\)/);
  assert.match(comment, /Other invalidated claims/);
  assert.match(comment, /c_extracted/);
  assert.match(comment, /c_new file:src\/new\.ts — imports_module/);

  const teamSection = comment.split('Other invalidated claims')[0];
  assert.doesNotMatch(teamSection, /c_extracted/, 'extractor claims must not be reported as team claims');

  assert.equal(metrics.added, '1');
  assert.equal(metrics.removed, '0');
  assert.equal(metrics.stale, '3');
  assert.equal(metrics.team_stale, '2');

  console.log('[OK] action memory smoke: JSON parsing flags team-authored invalidations');
} finally {
  rmSync(work, { recursive: true, force: true });
}
