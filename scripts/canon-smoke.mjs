#!/usr/bin/env node
// Canon #85: trust axis migration, backfill and the write-path defaults.
// Proves the migration is idempotent on a store created before Canon existed.
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { createDb, openDb, dbPathFor } from '../dist/db.js';
import { approveDrafts, rejectDraft } from '../dist/actions.js';
import { upsertClaim } from '../dist/model.js';

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

for (const dir of roots) rmSync(dir, { recursive: true, force: true });

if (failures) {
  console.error(`\nCANON SMOKE FAILED — ${failures} check(s)`);
  process.exit(1);
}
console.log('\nCANON SMOKE OK — migration, backfill, idempotence, write path, approve, reject');
