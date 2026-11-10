import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DB } from './db.js';
import { claimId, sha256, treeHash } from './util/hash.js';

export type EvidenceKind = 'test' | 'file' | 'command' | 'human' | 'agent';
export type ClaimState = 'draft' | 'active' | 'retracted';

export interface EvidenceInput {
  kind: EvidenceKind;
  ref: string;
  hash?: string | null;
}

export interface WriteInput {
  subject: string;
  predicate: string;
  object: string;
  evidence: EvidenceInput[];
  confidence?: number;
  author?: string;
  validFrom?: string | null;
}

export interface UpsertResult {
  id: string;
  inserted: boolean;
  state: ClaimState;
  authority: number;
}

/** SPEC §7 authority ladder. Lower = more trustworthy. */
export function authorityOf(kind: EvidenceKind): number {
  switch (kind) {
    case 'test':
      return 0;
    case 'file':
    case 'command':
      return 1;
    case 'human':
      return 2;
    case 'agent':
      return 4;
  }
}

function entityKind(id: string): string {
  const prefix = id.split(':')[0] ?? 'concept';
  const map: Record<string, string> = {
    sym: 'symbol',
    file: 'file',
    test: 'test',
    issue: 'issue',
    person: 'person',
    env: 'env',
    pkg: 'pkg',
    doc: 'doc',
    concept: 'concept',
  };
  return map[prefix] ?? 'concept';
}

export function ensureEntity(db: DB, id: string, now = new Date().toISOString()): void {
  const canonical = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
  db.prepare('INSERT OR IGNORE INTO entity(id, kind, canonical, created_at) VALUES (?, ?, ?, ?)').run(
    id,
    entityKind(id),
    canonical,
    now,
  );
}

/**
 * Insert a claim if its content hash is new. Existing claims are never mutated
 * except for draft -> active promotion, which is a state change, not content.
 */
export function upsertClaim(db: DB, input: WriteInput): UpsertResult {
  const now = new Date().toISOString();
  const authority = Math.min(...input.evidence.map((e) => authorityOf(e.kind)), 4);
  const id = claimId({
    subject: input.subject,
    predicate: input.predicate,
    object: input.object,
    valid_from: input.validFrom ?? null,
  });

  ensureEntity(db, input.subject, now);

  const existing = db.prepare('SELECT id, state FROM claim WHERE id = ?').get(id) as
    | { id: string; state: ClaimState }
    | undefined;

  const state: ClaimState = authority <= 1 ? 'active' : 'draft';

  if (!existing) {
    db.prepare(
      `INSERT INTO claim(id, subject_id, predicate, object_json, valid_from, valid_to, tx_from,
                         authority, confidence, author, supersedes, state)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      id,
      input.subject,
      input.predicate,
      JSON.stringify(input.object),
      input.validFrom ?? null,
      now,
      authority,
      input.confidence ?? (authority <= 1 ? 0.95 : 0.6),
      input.author ?? 'human:cli',
      state,
    );
  } else if (existing.state === 'draft' && state === 'active') {
    db.prepare(`UPDATE claim SET state = 'active', authority = ?, confidence = ? WHERE id = ?`).run(
      authority,
      input.confidence ?? 0.95,
      id,
    );
  }

  for (const ev of input.evidence) {
    db.prepare(
      `INSERT INTO evidence(claim_id, kind, ref, hash, verified_at, status)
       VALUES (?, ?, ?, ?, ?, 'valid')
       ON CONFLICT(claim_id, kind, ref) DO UPDATE SET
         hash = COALESCE(excluded.hash, evidence.hash),
         verified_at = excluded.verified_at,
         status = 'valid'`,
    ).run(id, ev.kind, ev.ref, ev.hash ?? null, now);
  }

  return { id, inserted: !existing, state, authority };
}

export function head(db: DB, ref: string): string | null {
  const row = db.prepare('SELECT commit_id FROM ref WHERE name = ?').get(ref) as
    | { commit_id: string }
    | undefined;
  return row?.commit_id ?? null;
}

export function resolveHead(db: DB, ref: string): string | null {
  return head(db, ref) ?? head(db, 'main');
}

/** Fold commit entries from root to tip. */
export function activeAt(db: DB, commitId: string | null): Map<string, string> {
  if (!commitId) return new Map();
  const chain: string[] = [];
  let cursor: string | null = commitId;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    chain.push(cursor);
    const row = db.prepare('SELECT parent_id FROM memory_commit WHERE id = ?').get(cursor) as
      | { parent_id: string | null }
      | undefined;
    cursor = row?.parent_id ?? null;
  }
  const set = new Map<string, string>();
  for (const c of chain.reverse()) {
    const entries = db
      .prepare('SELECT claim_id, op FROM commit_entry WHERE commit_id = ? ORDER BY rowid')
      .all(c) as Array<{ claim_id: string; op: string }>;
    for (const e of entries) {
      if (e.op === 'retract') set.delete(e.claim_id);
      else set.set(e.claim_id, e.op);
    }
  }
  return set;
}

export interface CommitInput {
  ref: string;
  entries: Array<{ claim_id: string; op: 'add' | 'supersede' | 'retract' | 'restore' }>;
  message: string;
  author: string;
  kind: 'init' | 'write' | 'merge' | 'revert' | 'gc' | 'import';
}

export function makeCommit(db: DB, input: CommitInput): string {
  const parent = resolveHead(db, input.ref);
  const set = activeAt(db, parent);
  for (const e of input.entries) {
    if (e.op === 'retract') set.delete(e.claim_id);
    else set.set(e.claim_id, e.op);
  }
  const tree = treeHash(set.keys());
  const ts = new Date().toISOString();
  const id = `k_${sha256(`${parent ?? 'root'}|${tree}|${input.message}|${input.author}|${ts}`).slice(0, 12)}`;

  db.prepare(
    'INSERT INTO memory_commit(id, parent_id, tree_hash, message, author, ts, kind) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, parent, tree, input.message, input.author, ts, input.kind);

  const insert = db.prepare('INSERT OR IGNORE INTO commit_entry(commit_id, claim_id, op) VALUES (?, ?, ?)');
  for (const e of input.entries) insert.run(id, e.claim_id, e.op);

  db.prepare(
    'INSERT INTO ref(name, commit_id) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET commit_id = excluded.commit_id',
  ).run(input.ref, id);

  return id;
}

export interface ClaimRow {
  id: string;
  subject_id: string;
  predicate: string;
  object_json: string;
  valid_from: string | null;
  tx_from: string;
  authority: number;
  confidence: number;
  author: string;
  state: ClaimState;
  supersedes: string | null;
}

export function claimsFor(db: DB, subject: string): ClaimRow[] {
  return db
    .prepare(
      `SELECT * FROM claim
       WHERE subject_id = ? OR subject_id LIKE ?
       ORDER BY predicate, tx_from DESC`,
    )
    .all(subject, `${subject}%`) as ClaimRow[];
}

export function evidenceFor(db: DB, claim: string): Array<{ kind: string; ref: string; hash: string | null; verified_at: string | null; status: string }> {
  return db
    .prepare('SELECT kind, ref, hash, verified_at, status FROM evidence WHERE claim_id = ? ORDER BY kind, ref')
    .all(claim) as Array<{ kind: string; ref: string; hash: string | null; verified_at: string | null; status: string }>;
}

export function fileHash(absPath: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(absPath)).digest('hex')}`;
}
