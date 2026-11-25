import assert from 'node:assert/strict';
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

// 5. Monorepo nested manifests, Makefile, Compose, Python, and Go extraction (#182)
import { execFileSync } from 'node:child_process';
const monoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-mono-extract-'));
try {
  fs.mkdirSync(path.join(monoDir, 'frontend'), { recursive: true });
  fs.mkdirSync(path.join(monoDir, 'backend'), { recursive: true });
  fs.mkdirSync(path.join(monoDir, 'services', 'api'), { recursive: true });
  fs.mkdirSync(path.join(monoDir, 'infra'), { recursive: true });

  fs.writeFileSync(
    path.join(monoDir, 'frontend', 'package.json'),
    JSON.stringify({
      name: 'web-ui',
      scripts: { dev: 'next dev' },
      dependencies: { react: '^19.0.0' },
      keywords: ['telemetry', 'dashboard'],
    }),
  );
  fs.writeFileSync(
    path.join(monoDir, 'backend', 'requirements.txt'),
    '# backend deps\nfastapi>=0.115.0\nuvicorn[standard]==0.32.0\n-r base.txt\n',
  );
  fs.writeFileSync(
    path.join(monoDir, 'backend', 'pyproject.toml'),
    '[project]\nname = "f1-backend"\ndependencies = ["pydantic>=2.0"]\n',
  );
  fs.writeFileSync(
    path.join(monoDir, 'backend', 'app.py'),
    'import os, numpy as np\nfrom fastapi import FastAPI\nfrom .local import helper\napp = FastAPI()\n',
  );
  fs.writeFileSync(
    path.join(monoDir, 'services', 'api', 'go.mod'),
    'module github.com/acme/api\n\ngo 1.23\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.10.0\n)\n',
  );
  fs.writeFileSync(
    path.join(monoDir, 'infra', 'Makefile'),
    '.PHONY: up\nup:\n\tdocker compose up -d\n',
  );
  fs.writeFileSync(
    path.join(monoDir, 'infra', 'docker-compose.yml'),
    'services:\n  api:\n    image: python:3.12-slim\n    ports:\n      - "8000:8000"\n',
  );

  fs.mkdirSync(path.join(monoDir, 'admin'), { recursive: true });
  fs.writeFileSync(
    path.join(monoDir, 'admin', 'package.json'),
    JSON.stringify({
      name: 'admin-ui',
      dependencies: { react: '^18.3.0' },
    }),
  );

  const mono = extractAll(monoDir);
  assert(mono.some((c) => c.subject.startsWith('pkg:react') && c.predicate === 'declared_dependency' && c.evidenceRef === 'frontend/package.json'));
  assert(mono.some((c) => c.subject.startsWith('pkg:react') && c.predicate === 'declared_dependency' && c.evidenceRef === 'admin/package.json'));
  assert(mono.some((c) => c.subject === 'file:frontend/package.json' && c.predicate === 'defines_script'));
  assert(mono.some((c) => c.subject === 'pkg:fastapi' && c.predicate === 'declared_dependency' && c.evidenceRef === 'backend/requirements.txt'));
  assert(mono.some((c) => c.subject === 'pkg:pydantic' && c.predicate === 'declared_dependency' && c.evidenceRef === 'backend/pyproject.toml'));
  assert(mono.some((c) => c.subject === 'file:backend/app.py' && c.predicate === 'imports_module' && c.object === 'fastapi'));
  assert(mono.some((c) => c.subject === 'file:backend/app.py' && c.predicate === 'imports_module' && c.object === 'numpy'));
  assert(!mono.some((c) => c.subject === 'file:backend/app.py' && c.object === '.local'), 'relative python import must be skipped');
  assert(mono.some((c) => c.subject === 'pkg:github.com/gin-gonic/gin' && c.predicate === 'declared_dependency' && c.evidenceRef === 'services/api/go.mod'));
  assert(mono.some((c) => c.subject === 'file:infra/Makefile' && c.predicate === 'has_make_target' && c.object === 'up'));
  assert(mono.some((c) => c.subject === 'file:infra/docker-compose.yml' && c.predicate === 'uses_image' && c.object === 'python:3.12-slim'));

  const cli = path.join(process.cwd(), 'dist', 'cli.js');
  execFileSync('node', [cli, 'init'], { cwd: monoDir });
  execFileSync('node', [cli, 'ingest'], { cwd: monoDir });
  execFileSync('node', [cli, 'verify', '--all', '--strict'], { cwd: monoDir });
  const canon = JSON.parse(execFileSync('node', [cli, 'canon', 'status', '--json'], { cwd: monoDir, encoding: 'utf8' }));
  assert.equal(canon.trust.contested, 0, 'monorepo with differing dependency versions must not produce contested claims');
  assert.equal(canon.unresolved_conflicts, 0, 'monorepo must produce 0 unresolved tier-1 conflicts');
  console.log('[OK] monorepo & python/go/make/compose extraction + verify passed');
} finally {
  fs.rmSync(monoDir, { recursive: true, force: true });
}
