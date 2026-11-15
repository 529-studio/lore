# Domain Invariants Extraction & npm Update Checker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evolve Lore's static extractor to automatically capture deep domain invariants and architecture rules (from in-code annotations, ADR decisions, and lessons) and add a non-blocking npm update checking command and utility.

**Architecture:** Extend `src/extract/index.ts` with multi-language comment parsing (`lore:invariant`, `lore:rule`, `INVARIANT:`, `RULE:`) and deep document extractors for ADR decisions (`adr:<id> decides`) and lessons (`lesson:<id> defines_rule`). Update ontology templates to establish cardinality-many predicates for rules and invariants. Introduce `src/update.ts` and `src/commands/update.ts` using native Node 22 `fetch` with strict timeouts and local caching to check the latest version of `@529studio/lore` on npm registry.

**Tech Stack:** TypeScript, Node.js 22 (native `fetch`, `AbortSignal.timeout`), better-sqlite3, Commander CLI, Picocolors.

**Spec:** Independent audit feedback from `projectKV` evaluation + Feature request for npm update check.

## Global Constraints

- Root cause, never convenient patch (AGENTS.md Rule 1).
- Passing unit tests are never sufficient: every claim verified with command outputs (AGENTS.md Rule 2).
- Merge commits only (`gh pr merge --merge`), no squash or rebase merge (AGENTS.md Rule 4).
- English, no emoji anywhere in code, commits, logs, or chat replies. Use `[OK]`, `[WARN]`, `[ERR]` (AGENTS.md Rule 5).
- Always-loaded docs (`README.md`, `AGENTS.md`, `CONTRIBUTING.md`) must stay under 16 KB each and 36 KB combined (AGENTS.md Rule 7).
- Ingestion must remain 100% deterministic and idempotent: running `lore ingest` twice in a row must produce 0 new claims.
- Network checks must be non-blocking with a max timeout of 2000ms and safe offline fallbacks.

## Review Focus

1. **Multiline or trailing comment noise in source code**: Comment extractors must strip comment prefixes (`//`, `#`, `/*`, `*`, `*/`) cleanly without capturing code snippets or syntax errors.
2. **Idempotency on repeated ingestion**: In-code invariant claim subjects use line anchors (`file:path#L<num>`) or stable slug anchors; line shifts in unrelated code must not explode claim duplication without reason.
3. **Registry network failure / offline mode**: `lore check-update` or background check must never throw unhandled promise rejections or hang the CLI when offline or when npm registry returns 404/500/timeout.
4. **Markdown section boundaries**: ADR and Lesson section extractors must respect Markdown heading boundaries (`## ` or `# `) and not spill the entire file into a single fact object.
5. **Ontology cardinality and conflict safety**: Predicates `enforces_invariant`, `defines_rule`, `decides`, `has_guardrail` must be registered with `cardinality: many` so multiple rules in the same file/repo do not falsely trigger merge conflicts.

---

### Task 1: npm Update Checker Subsystem

**Files:**
- Create: `src/update.ts`
- Create: `src/commands/update.ts`
- Create: `scripts/update-smoke.mjs`
- Modify: `src/cli.ts:40-60`
- Modify: `src/commands/status.ts:110-120`

**Interfaces:**
- Produces:
  - `checkNpmUpdate(pkgName: string, currentVersion: string, opts?: { timeoutMs?: number }): Promise<UpdateCheckResult>`
  - `isNewerVersion(current: string, latest: string): boolean`
  - `checkUpdateCommand(opts: { json?: boolean }): Promise<void>`

- [ ] **Step 1: Write the failing test in `scripts/update-smoke.mjs`**

```javascript
import assert from 'node:assert/strict';
import { isNewerVersion } from '../dist/update.js';

assert.equal(isNewerVersion('0.4.0', '0.5.0'), true);
assert.equal(isNewerVersion('0.5.0', '0.5.0'), false);
assert.equal(isNewerVersion('0.5.0', '0.4.9'), false);
assert.equal(isNewerVersion('0.5.0-beta.1', '0.5.0'), true);
console.log('[OK] semver compare tests passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/update-smoke.mjs`
Expected: FAIL with "Cannot find module '../dist/update.js'"

- [ ] **Step 3: Implement `src/update.ts` and `src/commands/update.ts`**

Implement:
- `isNewerVersion(current: string, latest: string): boolean` with clean semver parsing (major, minor, patch, prerelease).
- `checkNpmUpdate(packageName: string, currentVersion: string, opts?: { timeoutMs?: number })`:
  Uses `fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`, { signal: AbortSignal.timeout(timeoutMs ?? 2000), headers: { 'Accept': 'application/json' } })`. Returns `{ current, latest, updateAvailable }`. Catches all errors safely and returns `{ current, latest: null, updateAvailable: false, error: err.message }`.
- `checkUpdateCommand(opts: { json?: boolean })`:
  Outputs JSON when `--json` is provided, or formatted `[OK] lore is up to date (vX.Y.Z)` / `[WARN] update available: X.Y.Z -> A.B.C\nrun npm install -g @529studio/lore to update`.
- Register `lore check-update` in `src/cli.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node scripts/update-smoke.mjs && node dist/cli.js check-update --json`
Expected: PASS with valid JSON output containing `current: "0.5.0"`.

- [ ] **Step 5: Commit**

```bash
git add src/update.ts src/commands/update.ts src/cli.ts scripts/update-smoke.mjs
git commit -m "feat(cli): add npm update checker subsystem and check-update command"
```

---

### Task 2: Ontology Definition for Domain Invariants and Architecture Rules

**Files:**
- Modify: `templates/code/lore.ontology.yml`
- Modify: `templates/product/lore.ontology.yml`
- Modify: `lore.ontology.yml`
- Modify: `scripts/canon-smoke.mjs`

**Interfaces:**
- Consumes: `lore.ontology.yml`
- Produces: Registered predicates:
  - `enforces_invariant`: `{ cardinality: many, domain: file }`
  - `defines_rule`: `{ cardinality: many, domain: doc }`
  - `decides`: `{ cardinality: many, domain: adr }`
  - `has_guardrail`: `{ cardinality: many, domain: doc }`
  - `has_constraint`: `{ cardinality: many, domain: symbol }`
  - `describes_issue`: `{ cardinality: many, domain: doc }`

- [ ] **Step 1: Write test assertion in `scripts/extract-smoke.mjs`**

```javascript
import assert from 'node:assert/strict';
import { loadOntology } from '../dist/ontology.js';

const ont = loadOntology('.');
assert.equal(ont.cardinality('enforces_invariant'), 'many');
assert.equal(ont.cardinality('defines_rule'), 'many');
assert.equal(ont.cardinality('decides'), 'many');
assert.equal(ont.cardinality('has_guardrail'), 'many');
console.log('[OK] ontology invariant predicates verified');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node -e "import('./dist/ontology.js').then(m => { const ont = m.loadOntology('.'); console.assert(ont.cardinality('enforces_invariant') === 'many'); })"`
Expected: FAIL / assertion error because `enforces_invariant` defaults to `one` when absent.

- [ ] **Step 3: Update ontology YAML files**

Add predicates to `templates/code/lore.ontology.yml`, `templates/product/lore.ontology.yml`, and root `lore.ontology.yml`:
```yaml
  enforces_invariant: { cardinality: many, domain: file }
  defines_rule:       { cardinality: many, domain: doc }
  decides:            { cardinality: many, domain: adr }
  has_guardrail:      { cardinality: many, domain: doc }
  has_constraint:     { cardinality: many, domain: symbol }
  describes_issue:    { cardinality: many, domain: doc }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node -e "import('./dist/ontology.js').then(m => { const ont = m.loadOntology('.'); if (ont.cardinality('enforces_invariant') !== 'many') process.exit(1); console.log('[OK] cardinality verified'); })"`
Expected: `[OK] cardinality verified`

- [ ] **Step 5: Commit**

```bash
git add templates/code/lore.ontology.yml templates/product/lore.ontology.yml lore.ontology.yml
git commit -m "feat(ontology): add predicates for domain invariants, rules, and decisions"
```

---

### Task 3: Deep Document Extraction (ADR Decisions, Lesson Rules, and Agent Rules)

**Files:**
- Modify: `src/extract/index.ts:285-330`
- Test: `scripts/extract-smoke.mjs`

**Interfaces:**
- Consumes: `extractAll(root: string): Candidate[]`
- Produces: Candidates for:
  - `adr:<id>` with predicate `decides` and text extracted from section `## Decision`.
  - `lesson:L<id>` with predicate `defines_rule` extracted from `## Guardrail` / `**Guardrail.**` / `## Rule`.
  - `lesson:L<id>` with predicate `describes_issue` extracted from `## What happened` / `**What happened.**`.
  - `doc:<path>#<slug>` with predicate `defines_rule` extracted from `AGENTS.md`, `CLAUDE.md`, `ARCHITECTURE.md`.

- [ ] **Step 1: Write the failing test in `scripts/extract-smoke.mjs`**

```javascript
import assert from 'node:assert/strict';
import { extractAll } from '../dist/extract/index.js';

const candidates = extractAll('.');
const decisions = candidates.filter(c => c.predicate === 'decides');
assert(decisions.length > 0, 'expected ADR decisions to be extracted');
const adr1Decision = decisions.find(c => c.subject === 'adr:001');
assert(adr1Decision, 'expected adr:001 decides claim');
assert(adr1Decision.object.includes('SQLite file at .lore/lore.db'));

const rules = candidates.filter(c => c.predicate === 'defines_rule');
assert(rules.length > 0, 'expected lesson rules or agent rules');
const lesson1 = rules.find(c => c.subject === 'lesson:L01' || c.subject.includes('L01'));
assert(lesson1, 'expected lesson L01 rule to be extracted');
console.log('[OK] doc extraction tests passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node scripts/extract-smoke.mjs`
Expected: FAIL with "expected ADR decisions to be extracted"

- [ ] **Step 3: Implement section body extractors in `src/extract/index.ts`**

Implement helper functions:
- `extractSectionBody(text: string, headingRegex: RegExp): string | null`: Extracts up to 500 characters of clean text under a matching heading until the next heading or EOF.
- `extractInlinePrefix(text: string, prefixRegex: RegExp): string | null`: Extracts sentences following bold markers like `**Guardrail.** <text>` or `**What happened.** <text>`.
- In `extractAll`:
  - When matching `ADR_PATH_RE`: extract `## Decision` body and emit `{ subject: id, predicate: 'decides', object: decisionText, confidence: 0.95, evidenceRef: rel }`.
  - When matching `/(?:^|\/)docs\/lessons\/L(\d+)[-_]?([^/]*)\.md$/i`: emit `subject: 'lesson:L' + m[1]` with `defines_rule` and `describes_issue`.
  - When matching `AGENTS.md` or `ARCHITECTURE.md` rule headings (`## [0-9]+\.\s*(.+)`): extract first paragraph and emit `{ subject: 'doc:' + rel + '#' + slug(heading), predicate: 'defines_rule', object: text, confidence: 0.9, evidenceRef: rel }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node scripts/extract-smoke.mjs`
Expected: `[OK] doc extraction tests passed`

- [ ] **Step 5: Commit**

```bash
git add src/extract/index.ts scripts/extract-smoke.mjs
git commit -m "feat(extract): extract ADR decisions, lesson guardrails, and agent rules"
```

---

### Task 4: In-Code Invariant & Rule Extraction Across Source Files

**Files:**
- Modify: `src/extract/index.ts:220-250`
- Modify: `scripts/extract-smoke.mjs`

**Interfaces:**
- Consumes: Source code text and relative file path
- Produces: Candidates for in-code invariants:
  - `subject: file:<rel>#L<lineNumber>`
  - `predicate: enforces_invariant | defines_rule | decides | has_constraint`
  - `object: <trimmed invariant text>`
  - `evidenceRef: <rel>`
  - `confidence: 0.95`

- [ ] **Step 1: Write test case with code fixtures in `scripts/extract-smoke.mjs`**

Add fixture checks in `scripts/extract-smoke.mjs`:
```javascript
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractAll } from '../dist/extract/index.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-test-invariants-'));
try {
  fs.writeFileSync(path.join(tempDir, 'main.go'), [
    'package main',
    '// lore:invariant Hand-written SQL only, no ORMs allowed',
    '// lore:rule Leap zoom at least +2 when clicking cluster >= 20',
    'func main() {}'
  ].join('\n'));

  fs.writeFileSync(path.join(tempDir, 'safety.py'), [
    '# INVARIANT: Camera with flood report must never be merged into cluster',
    'def check(): pass'
  ].join('\n'));

  const candidates = extractAll(tempDir);
  const invariants = candidates.filter(c => c.predicate === 'enforces_invariant');
  assert.equal(invariants.length, 2);
  assert(invariants.some(c => c.object.includes('Hand-written SQL')));
  assert(invariants.some(c => c.object.includes('Camera with flood report')));

  const codeRules = candidates.filter(c => c.predicate === 'defines_rule');
  assert(codeRules.some(c => c.object.includes('Leap zoom at least +2')));
  console.log('[OK] in-code invariant extraction passed');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/extract-smoke.mjs`
Expected: FAIL with "invariants.length expected 2, got 0"

- [ ] **Step 3: Implement in-code invariant scanning in `src/extract/index.ts`**

Define regexes matching comments in text files:
- Tagged comments: `(?:^|\n)[ \t]*(?:\/\/|#|\/\*)[ \t]*lore:(invariant|rule|constraint|decision)[ \t]*:?[ \t]*([^\r\n*]+)`
- Conventional uppercase comments: `(?:^|\n)[ \t]*(?:\/\/|#|\/\*)[ \t]*(INVARIANT|RULE|CONSTRAINT)[ \t]*:?[ \t]*([^\r\n*]+)`
Map keyword to predicate:
- `invariant` / `INVARIANT` -> `enforces_invariant`
- `rule` / `RULE` -> `defines_rule`
- `constraint` / `CONSTRAINT` -> `has_constraint`
- `decision` -> `decides`
Extract line number by counting line breaks before match index.
Emit candidate with `subject: 'file:' + rel + '#L' + line`, `evidenceRef: rel`, `confidence: 0.95`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node scripts/extract-smoke.mjs`
Expected: `[OK] in-code invariant extraction passed`

- [ ] **Step 5: Commit**

```bash
git add src/extract/index.ts scripts/extract-smoke.mjs
git commit -m "feat(extract): extract in-code domain invariants and rules across source files"
```

---

### Task 5: End-to-End Integration, Retrieval Verification & Ingestion Idempotency

**Files:**
- Modify: `scripts/smoke.sh:50-70`
- Modify: `README.md:120-135`
- Test: `npm run smoke`
- Test: `npm run docs:lint`
- Test: `npm run check:public`

**Interfaces:**
- Consumes: All updated extractors and update command
- Produces: Passing end-to-end smoke tests and updated documentation

- [ ] **Step 1: Add invariant and ADR fixtures to `scripts/smoke.sh`**

In `scripts/smoke.sh`:
- Add `// lore:invariant Hand-written SQL only` to `src/cli.js`.
- Add `docs/adr/ADR-001-test.md` with `## Decision\nUse SQLite content-addressed claims.`
- Run `lore ingest --dry-run` and verify `enforces_invariant` and `decides` appear.
- Run `lore ingest` and verify claims become active.
- Run `lore search --query "sql orm"` and verify hit with score > 0.
- Verify second `lore ingest` produces `0 new claims` (idempotency preserved).
- Verify `lore check-update --json` runs without error.

- [ ] **Step 2: Run `bash scripts/smoke.sh`**

Run: `bash scripts/smoke.sh`
Expected: `SMOKE OK`

- [ ] **Step 3: Update documentation in `README.md` and check budget**

Document:
- In-code invariant tagging (`// lore:invariant ...`, `// lore:rule ...`).
- `lore check-update` command.
Run `npm run docs:lint` to verify size budget (< 16 KB each, < 36 KB combined).

- [ ] **Step 4: Run all verification suites**

Run:
1. `npm run typecheck`
2. `npm run smoke`
3. `npm run mcp:smoke`
4. `npm run setup:smoke`
5. `npm run docs:lint`
6. `npm run check:public`
Expected: All suites PASS.

- [ ] **Step 5: Commit and open PR**

```bash
git add scripts/smoke.sh README.md docs/
git commit -m "feat: complete domain invariants extraction and update check support"
```
