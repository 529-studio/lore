import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { extractAll } from '../dist/extract/index.js';

const candidates = extractAll('.');

// 1. ADR Decision Extraction
const decisions = candidates.filter((c) => c.predicate === 'decides');
assert(decisions.length > 0, 'expected ADR decisions to be extracted');
const adr1Decision = decisions.find((c) => c.subject === 'adr:001');
assert(adr1Decision, 'expected adr:001 decides claim');
assert(
  adr1Decision.object.includes('SQLite file at .lore/lore.db'),
  `unexpected adr:001 object: ${adr1Decision.object}`,
);

// 2. Lesson Rule / Guardrail Extraction
const rules = candidates.filter((c) => c.predicate === 'defines_rule');
assert(rules.length > 0, 'expected lesson rules or agent rules to be extracted');
const lesson4 = rules.find((c) => c.subject === 'lesson:L04');
assert(lesson4, 'expected lesson:L04 to be extracted with defines_rule');
assert(
  lesson4.object.includes('When a shared helper is the fix, delete the unsafe variant'),
  `unexpected lesson4 object: ${lesson4.object}`,
);

const issues = candidates.filter((c) => c.predicate === 'describes_issue');
const lesson4Issue = issues.find((c) => c.subject === 'lesson:L04');
assert(lesson4Issue, 'expected lesson:L04 to be extracted with describes_issue');
assert(
  lesson4Issue.object.includes('hashFile was hardened against path traversal'),
  `unexpected lesson4 issue object: ${lesson4Issue.object}`,
);

// 3. AGENTS.md Rule Extraction
const agentRule1 = rules.find((c) => c.subject.includes('doc:AGENTS.md') && c.subject.includes('root-cause'));
assert(agentRule1, 'expected AGENTS.md rule 1 (root-cause) to be extracted');
assert(agentRule1.object.includes('Do not ship a band-aid'), `unexpected agent rule: ${agentRule1.object}`);

console.log('[OK] doc extraction tests passed');

// 4. In-code invariant extraction across languages
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-test-invariants-'));
try {
  fs.writeFileSync(
    path.join(tempDir, 'main.go'),
    [
      'package main',
      '// lore:invariant Hand-written SQL only, no ORMs allowed',
      '// lore:rule Leap zoom at least +2 when clicking cluster >= 20',
      'func main() {}',
    ].join('\n'),
  );

  fs.writeFileSync(
    path.join(tempDir, 'safety.py'),
    [
      '# INVARIANT: Camera with flood report must never be merged into cluster',
      'def check(): pass',
    ].join('\n'),
  );

  const codeCandidates = extractAll(tempDir);
  const invariants = codeCandidates.filter((c) => c.predicate === 'enforces_invariant');
  assert.equal(invariants.length, 2, `expected 2 in-code invariants, got ${invariants.length}`);
  assert(invariants.some((c) => c.object.includes('Hand-written SQL')));
  assert(invariants.some((c) => c.object.includes('Camera with flood report')));

  const codeRules = codeCandidates.filter((c) => c.predicate === 'defines_rule');
  assert(codeRules.some((c) => c.object.includes('Leap zoom at least +2')));
  console.log('[OK] in-code invariant extraction passed');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

// 5. Polyglot monorepo: nested manifests, Python/Go dependencies, hash evidence
const monorepo = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-test-monorepo-'));
const writeFixture = (rel, body) => {
  const abs = path.join(monorepo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
};
try {
  writeFixture(
    'frontend/package.json',
    JSON.stringify({ name: 'web', dependencies: { react: '^18.2.0' }, scripts: { build: 'vite build' } }, null, 2),
  );
  writeFixture('frontend/Makefile', 'build:\n\t@echo build\n');
  writeFixture(
    'ops/docker-compose.yml',
    'services:\n  api:\n    image: python:3.12-slim\n    ports:\n      - "8000:8000"\n',
  );
  writeFixture(
    'backend/requirements.txt',
    [
      '# runtime dependencies',
      'requests==2.31.0',
      'Django>=4.2,<5',
      '-r dev-requirements.txt',
      'pydantic[email]>=2.6  # extras and a comment',
      'git+https://example.com/private.git#egg=private',
      '',
    ].join('\n'),
  );
  writeFixture(
    'backend/pyproject.toml',
    [
      '[build-system]',
      'requires = ["setuptools>=68"]',
      '',
      '[project]',
      'name = "backend"',
      'dependencies = [',
      '  "fastapi>=0.110",',
      '  "uvicorn[standard]",',
      '  # "fake-pkg>=1.0" is a comment, not a dependency',
      '  "tenacity>=8",',
      ']',
      '',
      '[project.optional-dependencies]',
      'dev = ["pytest>=8"]',
      '',
      '[tool.poetry.dependencies]',
      'python = "^3.11"',
      'sqlalchemy = "^2.0"',
      'httpx = { version = ">=0.27", optional = true }',
      '',
    ].join('\n'),
  );
  writeFixture(
    'backend/app.py',
    [
      '"""Service entrypoint.',
      '',
      'Usage example, not an import:',
      '    from fake.module import thing',
      '    marker = \\"""',
      '    from fake.late import late',
      '"""',
      'import os',
      'import this',
      'import pydoc_data',
      'import json',
      'import requests  # noqa: E402',
      'import requests.adapters',
      'from django.db import models',
      'from . import local',
      'from .helpers import helper',
      'from __future__ import annotations',
      '',
    ].join('\n'),
  );
  writeFixture(
    'go.mod',
    [
      'module example.com/svc',
      '',
      'go 1.22',
      '',
      'require (',
      '\tgithub.com/gin-gonic/gin v1.9.1',
      '\tgolang.org/x/sync v0.3.0 // indirect',
      ')',
      '',
      'require github.com/google/uuid v1.5.0',
      '',
    ].join('\n'),
  );
  // Malformed manifests are skipped, never thrown.
  writeFixture('broken/requirements.txt', '-r\n:::\n');
  writeFixture('broken/pyproject.toml', '[project\ndependencies = ["unterminated\n');
  writeFixture('broken/go.mod', 'require (\n');

  const mono = extractAll(monorepo);
  const declared = (subject) => mono.filter((c) => c.predicate === 'declared_dependency' && c.subject === subject);

  assert.equal(declared('pkg:react').length, 1, 'nested package.json dependency missing');
  assert.equal(declared('pkg:react')[0].evidenceRef, 'frontend/package.json');
  assert.equal(declared('pkg:requests')[0]?.object, '==2.31.0');
  assert.equal(declared('pkg:requests')[0]?.evidenceRef, 'backend/requirements.txt');
  assert.equal(declared('pkg:django')[0]?.object, '>=4.2,<5');
  assert.equal(declared('pkg:pydantic')[0]?.object, '>=2.6');
  assert.equal(declared('pkg:fastapi')[0]?.evidenceRef, 'backend/pyproject.toml');
  assert.equal(declared('pkg:sqlalchemy')[0]?.evidenceRef, 'backend/pyproject.toml');
  assert.equal(declared('pkg:httpx')[0]?.object, '>=0.27');
  assert.equal(declared('pkg:setuptools')[0]?.object, '>=68');
  assert.equal(declared('pkg:uvicorn')[0]?.object, '*', 'extras bracket must not end the array');
  assert.equal(declared('pkg:tenacity')[0]?.object, '>=8', 'entries after a comment must still parse');
  assert.equal(declared('pkg:fake-pkg').length, 0, 'commented-out dependency must be skipped');
  assert.equal(declared('pkg:github.com/gin-gonic/gin')[0]?.object, 'v1.9.1');
  assert.equal(declared('pkg:github.com/gin-gonic/gin')[0]?.evidenceRef, 'go.mod');
  assert.equal(declared('pkg:github.com/google/uuid')[0]?.object, 'v1.5.0');
  assert(!mono.some((c) => c.subject === 'pkg:private'), 'VCS requirement must be skipped');
  assert(!mono.some((c) => c.subject === 'pkg:dev-requirements'), 'include directive must be skipped');
  assert(!mono.some((c) => c.subject === 'pkg:python'), 'python runtime constraint is not a package');
  assert(
    !mono.some((c) => c.evidenceRef?.startsWith('broken/')),
    'malformed manifests must yield no claims',
  );

  const imported = (spec) =>
    mono.filter(
      (c) => c.predicate === 'imports_module' && c.subject === 'file:backend/app.py' && c.object === spec,
    ).length;
  for (const spec of ['requests', 'requests.adapters', 'django.db']) {
    assert.equal(imported(spec), 1, `expected imports_module ${spec}`);
  }
  for (const spec of ['os', 'json', 'this', 'pydoc_data', '__future__', '.', '.helpers', 'fake.module', 'fake.late']) {
    assert.equal(imported(spec), 0, `stdlib/relative/docstring import must be ignored: ${spec}`);
  }

  assert(
    mono.some(
      (c) => c.predicate === 'has_make_target' && c.subject === 'file:frontend/Makefile' && c.object === 'build',
    ),
    'nested Makefile target missing',
  );
  assert(
    mono.some(
      (c) =>
        c.predicate === 'uses_image' && c.subject === 'file:ops/docker-compose.yml' && c.object === 'python:3.12-slim',
    ),
    'nested compose image missing',
  );
  assert(mono.some((c) => c.predicate === 'publishes_port' && c.object === '8000:8000'), 'nested compose port missing');

  assert.equal(JSON.stringify(extractAll(monorepo)), JSON.stringify(mono), 'extraction must be deterministic');

  // End to end: ingest hashes the nested manifest each claim came from.
  execFileSync('git', ['init', '-q'], { cwd: monorepo });
  execFileSync('git', ['config', 'user.email', 'smoke@lore.local'], { cwd: monorepo });
  execFileSync('git', ['config', 'user.name', 'smoke'], { cwd: monorepo });
  execFileSync('git', ['add', '-A'], { cwd: monorepo });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: monorepo });

  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const lore = (...args) =>
    spawnSync(process.execPath, [cli, ...args], {
      cwd: monorepo,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', LORE_SESSION: 'extract-smoke' },
    });

  let run = lore('init');
  assert.equal(run.status, 0, `lore init failed: ${run.stderr}`);
  run = lore('ingest');
  assert.equal(run.status, 0, `lore ingest failed: ${run.stderr}`);
  assert.match(run.stdout, /declared_dependency/);
  assert.match(run.stdout, /imports_module/);

  run = lore('verify', '--all');
  assert.equal(run.status, 0, `lore verify --all failed: ${run.stderr}`);
  assert.match(run.stdout, /0 stale/, `expected 0 stale, got: ${run.stdout}`);

  const db = new Database(path.join(monorepo, '.lore', 'lore.db'), { readonly: true });
  const evidenceRows = (subject) =>
    db
      .prepare(
        'SELECT e.ref AS ref, e.hash AS hash FROM claim c JOIN evidence e ON e.claim_id = c.id WHERE c.subject_id = ?',
      )
      .all(subject);
  for (const [subject, ref] of [
    ['pkg:react', 'frontend/package.json'],
    ['pkg:requests', 'backend/requirements.txt'],
    ['pkg:fastapi', 'backend/pyproject.toml'],
    ['pkg:github.com/gin-gonic/gin', 'go.mod'],
  ]) {
    const rows = evidenceRows(subject);
    assert.equal(rows.length, 1, `expected one evidence row for ${subject}`);
    assert.equal(rows[0].ref, ref, `wrong evidence for ${subject}`);
    assert.match(rows[0].hash ?? '', /^sha256:[a-f0-9]{64}$/, `unhashed evidence for ${subject}`);
  }
  db.close();
  console.log('[OK] monorepo nested manifest, Python/Go, and hash verification passed');
} finally {
  fs.rmSync(monorepo, { recursive: true, force: true });
}
