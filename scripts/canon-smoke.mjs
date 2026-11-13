#!/usr/bin/env node
// Canon #85-#89: trust axis, backfill, conflicts, injection, decay and metrics.
// Proves the migration is idempotent and that contradictory writes are contested.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { createDb, openDb, dbPathFor } from '../dist/db.js';
import { approveDrafts, rejectDraft } from '../dist/actions.js';
import { claimIsEligible, supersedeClaim, upsertClaim } from '../dist/model.js';
import { installCanon } from '../dist/canon/index.js';
import { evaluateDecay, restoreAfterReverify, sweepDecay } from '../dist/canon/decay.js';
import { explainTarget } from '../dist/canon/explain.js';

process.env.NO_COLOR = '1';
delete process.env.LORE_TEAM_SECRET;
delete process.env.LORE_MACHINE;

let failures = 0;

function check(label, ok, detail = '') {
  if (ok) {
    console.log(`[OK] ${label}`);
  } else {
    failures += 1;
    console.log(`[ERR] ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(label, actual, expected) {
  check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const roots = [];
const CLI = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'dist', 'cli.js');

function runCli(cwd, args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`lore ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function tempRoot() {
  const dir = mkdtempSync(path.join(tmpdir(), 'lore-canon-'));
  roots.push(dir);
  return dir;
}

/**
 * A v0.4 store: every current table, but `claim` lacks the Canon columns and
 * `evidence.commit_id` exists (it shipped in 0.2).
 */
function writeLegacyStore(root, { evidenceHasCommit = true } = {}) {
  mkdirSync(path.join(root, '.lore'), { recursive: true });
  const db = new Database(dbPathFor(root));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE entity (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, canonical TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE claim (
      id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL REFERENCES entity(id),
      predicate TEXT NOT NULL,
      object_json TEXT NOT NULL,
      valid_from TEXT, valid_to TEXT,
      tx_from TEXT NOT NULL,
      authority INTEGER NOT NULL CHECK (authority BETWEEN 0 AND 4),
      confidence REAL NOT NULL,
      author TEXT NOT NULL,
      supersedes TEXT REFERENCES claim(id),
      state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','active','retracted'))
    );
    CREATE TABLE evidence (
      claim_id TEXT NOT NULL REFERENCES claim(id),
      kind TEXT NOT NULL, ref TEXT NOT NULL, hash TEXT,
      ${evidenceHasCommit ? 'commit_id TEXT,' : ''}
      verified_at TEXT, status TEXT NOT NULL DEFAULT 'valid',
      PRIMARY KEY (claim_id, kind, ref)
    );
    CREATE TABLE memory_commit (
      id TEXT PRIMARY KEY, parent_id TEXT REFERENCES memory_commit(id),
      tree_hash TEXT NOT NULL, message TEXT NOT NULL,
      author TEXT NOT NULL, ts TEXT NOT NULL, kind TEXT NOT NULL
    );
    CREATE TABLE merge_decision (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      commit_id TEXT NOT NULL,
      subject_id TEXT NOT NULL, predicate TEXT NOT NULL,
      winner TEXT, loser TEXT, rule TEXT NOT NULL, reason TEXT, ts TEXT NOT NULL
    );
    CREATE TABLE file_hash (
      path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime_ns TEXT NOT NULL,
      hash TEXT NOT NULL, checked_at TEXT NOT NULL
    );
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);

  const tx = '2026-11-01T00:00:00.000Z';
  const entity = db.prepare('INSERT INTO entity(id, kind, canonical, created_at) VALUES (?, ?, ?, ?)');
  for (const id of ['env:A', 'env:B', 'env:C', 'env:D', 'env:E']) entity.run(id, 'env', id.slice(4), tx);

  const claim = db.prepare(
    `INSERT INTO claim(id, subject_id, predicate, object_json, valid_from, tx_from,
                       authority, confidence, author, state)
     VALUES (?, ?, ?, ?, NULL, ?, ?, 0.9, ?, ?)`,
  );
  // 1: active + hashed evidence -> canonical
  claim.run('c_hash', 'env:A', 'p', '"1"', tx, 1, 'agent:codex/s1', 'active');
  // 2: active + commit-only evidence -> canonical
  claim.run('c_commit', 'env:B', 'p', '"2"', tx, 1, 'human:ana', 'active');
  // 3: active, no evidence -> candidate
  claim.run('c_noev', 'env:C', 'p', '"3"', tx, 4, 'legacy-tool', 'active');
  // 4: draft -> candidate
  claim.run('c_draft', 'env:D', 'p', '"4"', tx, 4, 'agent:claude/s2', 'draft');
  // 5: retracted -> retracted
  claim.run('c_dead', 'env:E', 'p', '"5"', tx, 2, 'human:bob', 'retracted');

  const ev = db.prepare(
    `INSERT INTO evidence(claim_id, kind, ref, hash, ${evidenceHasCommit ? 'commit_id, ' : ''}verified_at, status)
     VALUES (?, ?, ?, ?, ${evidenceHasCommit ? '?, ' : ''}?, 'valid')`,
  );
  if (evidenceHasCommit) {
    ev.run('c_hash', 'file', 'a.txt', 'sha256:aaa', null, '2026-11-02T10:00:00.000Z');
    ev.run('c_commit', 'file', 'b.txt', null, 'deadbeef', '2026-11-03T10:00:00.000Z');
  } else {
    ev.run('c_hash', 'file', 'a.txt', 'sha256:aaa', null);
  }

  db.close();
}

function trustOf(db, id) {
  return db.prepare('SELECT trust FROM claim WHERE id = ?').get(id).trust;
}

function contradictionsOf(db, id) {
  return db.prepare('SELECT contradictions FROM claim WHERE id = ?').get(id).contradictions;
}

function conflictsFor(db, subject, predicate) {
  return db.prepare('SELECT * FROM claim_conflict WHERE subject_id = ? AND predicate = ?').all(subject, predicate);
}

// --- A. backfill on a pre-Canon store ---------------------------------------
{
  const root = tempRoot();
  writeLegacyStore(root);

  const db = openDb(root);
  eq('active + hashed evidence is canonical', trustOf(db, 'c_hash'), 'canonical');
  eq('active + commit evidence is canonical', trustOf(db, 'c_commit'), 'canonical');
  eq('active without evidence is candidate', trustOf(db, 'c_noev'), 'candidate');
  eq('draft is candidate', trustOf(db, 'c_draft'), 'candidate');
  eq('retracted is retracted', trustOf(db, 'c_dead'), 'retracted');

  const writtenBy = Object.fromEntries(
    db.prepare('SELECT id, written_by FROM claim').all().map((r) => [r.id, r.written_by]),
  );
  eq('agent author backfills written_by=agent', writtenBy.c_hash, 'agent');
  eq('human author backfills written_by=human', writtenBy.c_commit, 'human');
  eq('unknown author backfills written_by=legacy', writtenBy.c_noev, 'legacy');

  const verified = db.prepare('SELECT id, last_verified_at FROM claim').all();
  const byId = Object.fromEntries(verified.map((r) => [r.id, r.last_verified_at]));
  eq('last_verified_at comes from the newest evidence', byId.c_hash, '2026-11-02T10:00:00.000Z');
  eq('last_verified_at falls back to tx_from', byId.c_noev, '2026-11-01T00:00:00.000Z');

  const meta = db.prepare("SELECT value FROM meta WHERE key = 'canon_backfill_v1'").get();
  check('backfill records its meta guard', Boolean(meta?.value));
  const stamp = meta?.value;
  db.close();

  // Idempotence: mutate a value, reopen, and the backfill must not run again.
  const raw = new Database(dbPathFor(root));
  raw.prepare("UPDATE claim SET trust = 'stale' WHERE id = 'c_noev'").run();
  raw.close();

  const reopened = openDb(root);
  eq('second open does not rerun the backfill', trustOf(reopened, 'c_noev'), 'stale');
  eq(
    'meta guard keeps one row and the first timestamp',
    reopened.prepare("SELECT COUNT(*) AS n FROM meta WHERE key = 'canon_backfill_v1'").get().n,
    1,
  );
  eq(
    'meta guard value is unchanged',
    reopened.prepare("SELECT value FROM meta WHERE key = 'canon_backfill_v1'").get().value,
    stamp,
  );
  reopened.close();
}

// --- B. opening a store whose evidence predates commit_id -------------------
{
  const root = tempRoot();
  writeLegacyStore(root, { evidenceHasCommit: false });
  const db = openDb(root);
  const cols = db.prepare('PRAGMA table_info(evidence)').all().map((c) => c.name);
  check('missing evidence.commit_id is added before the backfill', cols.includes('commit_id'));
  eq('backfill still runs on the older store', trustOf(db, 'c_hash'), 'canonical');
  db.close();
}

// --- C. write path defaults and approval ------------------------------------
{
  const root = tempRoot();
  const db = createDb(root);

  const observed = upsertClaim(db, {
    subject: 'env:PG',
    predicate: 'package_manager',
    object: 'npm',
    author: 'agent:codex/s1',
    evidence: [{ kind: 'file', ref: 'package-lock.json', hash: 'sha256:abc', commit: 'deadbeef' }],
  });
  eq('observed file evidence is active', observed.state, 'active');
  eq('observed file evidence is canonical', trustOf(db, observed.id), 'canonical');
  eq(
    'provenance is recorded on write',
    db.prepare('SELECT written_by, agent_id, session_id FROM claim WHERE id = ?').get(observed.id).written_by,
    'agent',
  );

  const inferred = upsertClaim(db, {
    subject: 'env:PG',
    predicate: 'preferred_pm',
    object: 'pnpm',
    author: 'agent:codex/s1',
    evidence: [{ kind: 'agent', ref: 'session:s1' }],
  });
  eq('inference stays a draft', inferred.state, 'draft');
  eq('draft inference is candidate', trustOf(db, inferred.id), 'candidate');

  const confirmed = upsertClaim(db, {
    subject: 'env:PG',
    predicate: 'team_size',
    object: '4',
    author: 'human:ana',
    forceActive: true,
    evidence: [],
  });
  eq('active without evidence stays candidate', trustOf(db, confirmed.id), 'candidate');

  const human = upsertClaim(db, {
    subject: 'env:PG',
    predicate: 'reviewed_by',
    object: 'ana',
    author: 'human:ana',
    evidence: [{ kind: 'human', ref: 'chat:42' }],
  });
  eq('human evidence alone is a draft', human.state, 'draft');
  eq('human draft is candidate', trustOf(db, human.id), 'candidate');

  const approved = approveDrafts(db, root, 'main', [inferred.id]);
  check('approve reports the claim', approved.changed.some((c) => c.claim_id === inferred.id));
  eq('approve makes a draft canonical', trustOf(db, inferred.id), 'canonical');
  check(
    'approve refreshes last_verified_at',
    Boolean(db.prepare('SELECT last_verified_at FROM claim WHERE id = ?').get(inferred.id).last_verified_at),
  );

  rejectDraft(db, root, 'main', human.id, 'smoke');
  eq('reject retracts trust', trustOf(db, human.id), 'retracted');
  db.close();
}

// --- D. tier-1 conflicts on write (#86) -------------------------------------
{
  const root = tempRoot();
  writeFileSync(
    path.join(root, 'lore.ontology.yml'),
    [
      'predicates:',
      '  package_manager: { cardinality: one }',
      '  uses_library: { cardinality: many }',
      '',
    ].join('\n'),
  );
  const db = createDb(root);
  installCanon();

  const observed = (subject, predicate, object, ref) =>
    upsertClaim(db, {
      subject,
      predicate,
      object,
      author: 'agent:codex/s1',
      evidence: [{ kind: 'file', ref, hash: `sha256:${object}`, commit: 'deadbeef' }],
    });

  const npm = observed('env:PM', 'package_manager', 'npm', 'package-lock.json');
  eq('first value of a one predicate is canonical', trustOf(db, npm.id), 'canonical');

  const pnpm = observed('env:PM', 'package_manager', 'pnpm', 'pnpm-lock.yaml');
  eq('second value becomes contested', trustOf(db, pnpm.id), 'contested');
  eq('first value becomes contested too', trustOf(db, npm.id), 'contested');
  eq('one conflict row is recorded', conflictsFor(db, 'env:PM', 'package_manager').length, 1);
  eq('the first claim counts one contradiction', contradictionsOf(db, npm.id), 1);
  eq('the second claim counts one contradiction', contradictionsOf(db, pnpm.id), 1);

  const again = observed('env:PM', 'package_manager', 'pnpm', 'pnpm-lock.yaml');
  check('rewriting the same value returns the same claim', again.id === pnpm.id);
  eq('rewriting the same value does not add a conflict row', conflictsFor(db, 'env:PM', 'package_manager').length, 1);
  eq('rewriting the same value does not double count', contradictionsOf(db, pnpm.id), 1);

  const react = observed('env:LIB', 'uses_library', 'react', 'package.json');
  const vue = observed('env:LIB', 'uses_library', 'vue', 'package.json');
  eq('many predicate keeps the first value canonical', trustOf(db, react.id), 'canonical');
  eq('many predicate keeps the second value canonical', trustOf(db, vue.id), 'canonical');
  eq('many predicate records no conflict', conflictsFor(db, 'env:LIB', 'uses_library').length, 0);

  const live = observed('env:ENTRY', 'entrypoint', 'main.js', 'main.js');
  const inference = upsertClaim(db, {
    subject: 'env:ENTRY',
    predicate: 'entrypoint',
    object: 'server.js',
    author: 'agent:codex/s1',
    evidence: [{ kind: 'agent', ref: 'session:s1' }],
  });
  eq('draft does not contest live memory', trustOf(db, live.id), 'canonical');
  eq('draft stays a candidate', trustOf(db, inference.id), 'candidate');
  eq('draft records no conflict', conflictsFor(db, 'env:ENTRY', 'entrypoint').length, 0);

  approveDrafts(db, root, 'main', [inference.id]);
  eq('approval contests the live side', trustOf(db, live.id), 'contested');
  eq('approval contests the approved side', trustOf(db, inference.id), 'contested');
  eq('approval records the conflict', conflictsFor(db, 'env:ENTRY', 'entrypoint').length, 1);

  const oldEntry = observed('env:ENTRY2', 'entrypoint', 'index.js', 'index.js');
  const replacement = supersedeClaim(db, oldEntry.id, {
    object: 'bin.js',
    author: 'human:ana',
    evidence: [{ kind: 'file', ref: 'bin.js', hash: 'sha256:bin', commit: 'deadbeef' }],
  });
  eq('supersede keeps the old row for history', trustOf(db, oldEntry.id), 'canonical');
  eq('supersede does not contest the replacement', trustOf(db, replacement.newId), 'canonical');
  eq('supersede records no conflict', conflictsFor(db, 'env:ENTRY2', 'entrypoint').length, 0);

  db.close();
}

// --- E. CLI wiring and injection filter (#86, #87) ---------------------------
{
  const root = tempRoot();
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['config', 'user.email', 'canon@smoke.local'], { cwd: root });
  spawnSync('git', ['config', 'user.name', 'canon'], { cwd: root });
  writeFileSync(path.join(root, 'package-lock.json'), 'npm\n');
  writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'pnpm\n');
  writeFileSync(path.join(root, 'package.json'), '{"name":"canon-smoke"}\n');

  runCli(root, ['init']);
  runCli(root, [
    'write', '--subject', 'env:NODE', '--predicate', 'node_version', '--object', '22',
    '--kind', 'file', '--ref', 'package.json', '--author', 'human:smoke', '--ttl-days', '1',
  ]);
  runCli(root, [
    'write', '--subject', 'env:PM', '--predicate', 'package_manager', '--object', 'npm',
    '--kind', 'file', '--ref', 'package-lock.json', '--author', 'human:smoke',
  ]);
  runCli(root, [
    'write', '--subject', 'env:PM', '--predicate', 'package_manager', '--object', 'pnpm',
    '--kind', 'file', '--ref', 'pnpm-lock.yaml', '--author', 'human:smoke',
  ]);

  const db = openDb(root);
  const rows = db.prepare('SELECT trust FROM claim WHERE subject_id = ? ORDER BY object_json').all('env:PM');
  eq('CLI write contests the first value', rows[0]?.trust, 'contested');
  eq('CLI write contests the second value', rows[1]?.trust, 'contested');
  eq('CLI write records the conflict', conflictsFor(db, 'env:PM', 'package_manager').length, 1);
  db.close();

  const contestedSearch = JSON.parse(runCli(root, ['search', 'package_manager', '--json']));
  eq('contested claim is not injected', contestedSearch.hits.length, 0);
  eq(
    'search warns about the contested fact',
    contestedSearch.warnings[0],
    'memory contested: env:PM:package_manager — see lore explain',
  );
  eq('search reports the contested fact', contestedSearch.contested.length, 1);
  eq('search lists both sides', contestedSearch.contested[0].claim_ids.length, 2);

  const exported = runCli(root, ['export', '--md']);
  check(
    'export withholds contested values',
    exported.includes('Withheld by Canon') &&
      !exported.includes('- **package_manager**: npm') &&
      !exported.includes('- **package_manager**: pnpm'),
  );

  const canonicalSearch = JSON.parse(runCli(root, ['search', 'node_version', '--json']));
  eq('canonical claim is injected', canonicalSearch.hits.length, 1);
  eq('canonical claim has no warning', canonicalSearch.warnings.length, 0);

  const explained = JSON.parse(runCli(root, ['explain', 'env:PM:package_manager', '--json']));
  eq('explain returns both contested claims', explained.claims.length, 2);
  check(
    'explain says why the claim is withheld',
    explained.claims.every((c) => c.trust === 'contested' && c.trust_reason.includes('unresolved tier-1')),
  );
  check(
    'explain shows provenance and evidence',
    explained.claims.every(
      (c) => c.written_by === 'human' && c.session_id && c.evidence.length === 1 && c.open_conflicts === 1,
    ),
  );

  const explainedId = JSON.parse(runCli(root, ['explain', explained.claims[0].id, '--json']));
  eq('explain accepts a claim id', explainedId.claims.length, 1);
  eq('explain accepts an entity id', JSON.parse(runCli(root, ['explain', 'env:PM', '--json'])).claims.length, 2);

  const canonStatus = JSON.parse(runCli(root, ['canon', 'status', '--json']));
  eq('canon status counts canonical', canonStatus.trust.canonical, 1);
  eq('canon status counts contested', canonStatus.trust.contested, 2);
  eq('canon status counts unresolved conflicts', canonStatus.unresolved_conflicts, 1);
  eq('canon status counts contested facts', canonStatus.contested_facts, 1);

  // --- #88 decay and #89 metrics through the real CLI -------------------------
  const nodeId = canonicalSearch.hits[0].id;
  const rawDb = openDb(root);
  eq(
    'CLI records the TTL',
    rawDb.prepare('SELECT ttl_days FROM claim WHERE id = ?').get(nodeId).ttl_days,
    1,
  );
  rawDb
    .prepare('UPDATE claim SET last_verified_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 3 * 86_400_000).toISOString(), nodeId);
  rawDb.close();

  eq(
    'TTL is evaluated on read before the sweep',
    JSON.parse(runCli(root, ['search', 'node_version', '--json'])).hits.length,
    0,
  );
  const explainedTtl = JSON.parse(runCli(root, ['explain', nodeId, '--json']));
  eq('explain reports pending TTL decay', explainedTtl.claims[0].decay?.trigger, 'ttl');

  const decayed = JSON.parse(runCli(root, ['canon', 'decay', '--json']));
  check(
    'canon decay persists the TTL',
    decayed.stale.some((h) => h.id === nodeId && h.decay.trigger === 'ttl'),
  );
  check(
    'include-stale shows the decayed claim',
    JSON.parse(runCli(root, ['search', 'node_version', '--include-stale', '--json'])).hits.some(
      (h) => h.id === nodeId && h.stale,
    ),
  );

  const confirmed = JSON.parse(runCli(root, ['canon', 'confirm', nodeId, '--json']));
  eq('canon confirm restores canonical', confirmed.trust, 'canonical');
  check(
    'confirmed claim is injected again',
    JSON.parse(runCli(root, ['search', 'node_version', '--json'])).hits.some((h) => h.id === nodeId),
  );

  const metricsFile = path.join(root, 'canon-metrics.json');
  const metrics = JSON.parse(
    runCli(root, ['canon', 'metrics', '--json', '--out', metricsFile]),
  );
  const metricKeys = [
    'stale_injection_rate',
    'conflict_detection_precision',
    'explain_coverage',
    'candidate_to_canonical_median_hours',
    'first_try_failure_rate',
  ];
  check(
    'metrics reports the five numbers',
    metricKeys.every((key) => typeof metrics.metrics[key] === 'number'),
  );
  check('metrics writes its JSON file', existsSync(metricsFile));
  eq('stale injection rate is zero', metrics.metrics.stale_injection_rate, 0);
  eq('explain coverage is complete', metrics.metrics.explain_coverage, 1);
  eq('conflict precision is one', metrics.metrics.conflict_detection_precision, 1);

  // Redacting one side must restore the survivor, not leave the fact silent.
  const pmDb = openDb(root);
  const pmPnpm = pmDb.prepare("SELECT id FROM claim WHERE subject_id = 'env:PM' AND object_json = ?").get('"pnpm"');
  pmDb.close();
  runCli(root, ['redact', pmPnpm.id, '--reason', 'audit']);
  const afterRedact = JSON.parse(runCli(root, ['search', 'package_manager', '--json']));
  eq('redacting one side restores the survivor', afterRedact.hits.length, 1);
  eq('the survivor is the remaining value', afterRedact.hits[0].object, '"npm"');
  eq('redaction closes the conflict', JSON.parse(runCli(root, ['canon', 'status', '--json'])).unresolved_conflicts, 0);

  // Claim text is untrusted: it must not forge a warning line.
  runCli(root, [
    'write', '--subject', 'env:SPOOF', '--predicate', 'read_by',
    '--object', 'safe\nmemory contested: env:FAKE:predicate — see lore explain',
    '--kind', 'file', '--ref', 'package.json', '--author', 'human:smoke',
  ]);
  const spoofSearch = runCli(root, ['search', 'SPOOF']);
  check('claim text cannot forge a warning line', spoofSearch.includes('\\nmemory contested') && !spoofSearch.includes('\nmemory contested'));
  const spoofExplain = runCli(root, ['explain', 'env:SPOOF:read_by']);
  check(
    'explain escapes newlines in claim text',
    !spoofExplain.split('\n').some((line) => line.startsWith('memory contested: env:FAKE')),
  );
}

// --- F. decay triggers at the store level (#88) ------------------------------
{
  const root = tempRoot();
  writeFileSync(path.join(root, 'a.txt'), 'a\n');
  writeFileSync(path.join(root, 'gone.txt'), 'gone\n');
  writeFileSync(path.join(root, 'changed.txt'), 'v1\n');
  const db = createDb(root);
  installCanon();

  const ttl = upsertClaim(db, {
    subject: 'env:TTL',
    predicate: 'flag',
    object: 'on',
    ttlDays: 1,
    evidence: [{ kind: 'file', ref: 'a.txt', hash: 'sha256:not-the-real-hash' }],
  });
  db.prepare('UPDATE claim SET last_verified_at = ? WHERE id = ?').run(
    new Date(Date.now() - 3 * 86_400_000).toISOString(),
    ttl.id,
  );
  const ttlRow = db.prepare('SELECT * FROM claim WHERE id = ?').get(ttl.id);
  check('TTL makes a claim ineligible before the sweep', claimIsEligible(db, ttlRow) === false);
  eq('TTL decay trigger', evaluateDecay(db, root, ttlRow, { checkHash: true })?.trigger, 'ttl');

  const sweep = sweepDecay(db, root);
  check('sweep reports the TTL claim', sweep.stale.some((h) => h.id === ttl.id && h.decay.trigger === 'ttl'));
  eq('decay keeps the row', db.prepare('SELECT COUNT(*) n FROM claim WHERE id = ?').get(ttl.id).n, 1);
  eq('sweep persists stale', trustOf(db, ttl.id), 'stale');
  eq('re-verify restores canonical', restoreAfterReverify(db, ttl.id, { confirm: true }), 'canonical');
  eq(
    're-verify clears the invalidation reason',
    db.prepare('SELECT invalidated_by_json FROM claim WHERE id = ?').get(ttl.id).invalidated_by_json,
    null,
  );
  eq(
    're-verify counts the confirmation',
    db.prepare('SELECT confirmations FROM claim WHERE id = ?').get(ttl.id).confirmations,
    1,
  );

  const gone = upsertClaim(db, {
    subject: 'env:GONE',
    predicate: 'flag',
    object: 'on',
    evidence: [{ kind: 'file', ref: 'gone.txt', hash: 'sha256:not-the-real-hash' }],
  });
  rmSync(path.join(root, 'gone.txt'));
  const goneSweep = sweepDecay(db, root);
  check(
    'a deleted evidence path decays',
    goneSweep.stale.some((h) => h.id === gone.id && h.decay.trigger === 'path-disappeared'),
  );
  eq('missing path persists stale', trustOf(db, gone.id), 'stale');
  check(
    'explain names path-disappeared',
    explainTarget(db, root, gone.id).claims[0].trust_reason.includes('path-disappeared'),
  );

  const changed = upsertClaim(db, {
    subject: 'env:CHANGED',
    predicate: 'flag',
    object: 'on',
    evidence: [{ kind: 'file', ref: 'changed.txt', hash: 'sha256:not-the-real-hash' }],
  });
  const changedSweep = sweepDecay(db, root);
  check(
    'a changed evidence hash decays',
    changedSweep.stale.some((h) => h.id === changed.id && h.decay.trigger === 'file-hash-changed'),
  );
  eq('changed hash persists stale', trustOf(db, changed.id), 'stale');
  db.close();
}

// --- G. sync trust merge and resolve (#88/#89 audit fixes) -------------------
{
  const base = tempRoot();
  const a = path.join(base, 'a');
  const b = path.join(base, 'b');
  const remote = path.join(base, 'remote');
  mkdirSync(a);
  mkdirSync(remote);
  spawnSync('git', ['init', '-q'], { cwd: a });
  spawnSync('git', ['config', 'user.email', 'sync@smoke.local'], { cwd: a });
  spawnSync('git', ['config', 'user.name', 'sync'], { cwd: a });
  writeFileSync(path.join(a, 'package.json'), '{"name":"canon-sync"}\n');
  writeFileSync(path.join(a, 'package-lock.json'), 'npm\n');
  writeFileSync(path.join(a, 'pnpm-lock.yaml'), 'pnpm\n');
  spawnSync('git', ['add', '-A'], { cwd: a });
  spawnSync('git', ['commit', '-qm', 'base'], { cwd: a });

  runCli(a, ['init']);
  runCli(a, [
    'write', '--subject', 'env:PM', '--predicate', 'package_manager', '--object', 'npm',
    '--kind', 'file', '--ref', 'package-lock.json', '--author', 'human:sync',
  ]);
  runCli(a, ['promote']);
  runCli(a, ['remote', remote]);
  runCli(a, ['push']);

  spawnSync('git', ['clone', '-q', a, b]);
  mkdirSync(path.join(b, '.lore'));
  cpSync(path.join(a, '.lore', 'config.json'), path.join(b, '.lore', 'config.json'));
  runCli(b, ['init']);
  runCli(b, ['remote', remote]);
  runCli(b, ['fetch']);
  eq('second store injects the shared claim before the conflict', JSON.parse(runCli(b, ['search', 'package_manager', '--json'])).hits.length, 1);

  runCli(a, [
    'write', '--subject', 'env:PM', '--predicate', 'package_manager', '--object', 'pnpm',
    '--kind', 'file', '--ref', 'pnpm-lock.yaml', '--author', 'human:sync',
  ]);
  runCli(a, ['promote']);
  runCli(a, ['push']);
  runCli(b, ['fetch']);

  const bdb = openDb(b);
  const npmB = bdb.prepare("SELECT id, trust FROM claim WHERE subject_id = 'env:PM' AND object_json = ?").get('"npm"');
  const pnpmB = bdb.prepare("SELECT id, trust FROM claim WHERE subject_id = 'env:PM' AND object_json = ?").get('"pnpm"');
  bdb.close();
  eq('sync imports contested trust for the old value', npmB.trust, 'contested');
  eq('sync imports contested trust for the new value', pnpmB.trust, 'contested');

  const afterSync = JSON.parse(runCli(b, ['search', 'package_manager', '--json']));
  eq('the second store withholds both values after the conflict sync', afterSync.hits.length, 0);
  check('the second store warns about the contested fact', afterSync.warnings[0]?.includes('env:PM:package_manager'));

  const resolved = JSON.parse(runCli(b, ['canon', 'resolve', 'env:PM:package_manager', '--keep', npmB.id, '--json']));
  eq('resolve keeps the selected claim', resolved.keep, npmB.id);
  check('resolve retracts the loser', resolved.losers.includes(pnpmB.id));

  const bdb2 = openDb(b);
  eq('resolve makes the winner canonical', trustOf(bdb2, npmB.id), 'canonical');
  eq('resolve retracts the loser trust', trustOf(bdb2, pnpmB.id), 'retracted');
  eq(
    'resolve closes the conflict',
    bdb2.prepare('SELECT COUNT(*) n FROM claim_conflict WHERE resolved = 0').get().n,
    0,
  );
  bdb2.close();

  const afterResolve = JSON.parse(runCli(b, ['search', 'package_manager', '--json']));
  eq('the winning value is injected after resolve', afterResolve.hits.length, 1);
  eq('no warning remains after resolve', afterResolve.warnings.length, 0);
  check('the injected value is the winner', afterResolve.hits[0].object.includes('npm'));
}

for (const dir of roots) rmSync(dir, { recursive: true, force: true });

if (failures) {
  console.error(`\nCANON SMOKE FAILED — ${failures} check(s)`);
  process.exit(1);
}
console.log('\nCANON SMOKE OK — migration, backfill, idempotence, write path, approve, reject, tier-1 conflicts, injection filter, explain, canon status, decay, confirm, metrics, sync trust merge, resolve');
