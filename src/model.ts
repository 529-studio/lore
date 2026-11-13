import { createHash } from 'node:crypto';
import type { DB } from './db.js';
import { claimId, sha256, treeHash } from './util/hash.js';
import { assertNoSecrets } from './secrets.js';

export type EvidenceKind = 'test' | 'file' | 'command' | 'human' | 'agent';
export type ClaimState = 'draft' | 'active' | 'retracted';

export interface EvidenceInput {
  kind: EvidenceKind;
  ref: string;
  hash?: string | null;
  /** Git HEAD at observation time, used to tell drift from a stale checkout. */
  commit?: string | null;
}

export interface WriteInput {
  subject: string;
  predicate: string;
  object: string;
  evidence: EvidenceInput[];
  confidence?: number;
  author?: string;
  validFrom?: string | null;
  supersedes?: string | null;
  /** Create the claim as active even when it would normally be a draft. */
  forceActive?: boolean;
  /** Keep an otherwise auto-promoted claim as a draft (policy gate). */
  forceDraft?: boolean;
  ttlDays?: number | null;
  writtenBy?: 'agent' | 'human' | 'legacy';
  agentId?: string | null;
  sessionId?: string | null;
  runId?: string | null;
}

export type Trust = 'canonical' | 'candidate' | 'contested' | 'stale' | 'retracted';

/**
 * Canon attaches to the write path through this hook. Core never imports the
 * canon module; it only calls whatever hooks were registered at startup.
 */
export type ClaimWriteHook = (db: DB, claimId: string) => void;
const claimWriteHooks: ClaimWriteHook[] = [];

export function registerClaimWriteHook(hook: ClaimWriteHook): void {
  claimWriteHooks.push(hook);
}

export function runClaimWriteHooks(db: DB, claimId: string): void {
  for (const hook of claimWriteHooks) hook(db, claimId);
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
  // Memory is an exfiltration path: a secret must never be persisted as a claim.
  assertNoSecrets({ subject: input.subject, predicate: input.predicate, object: input.object });

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

  // A file/test claim without a hash was never actually observed; it must not
  // enter retrieval (SPEC §6). A claim without any evidence is never canonical.
  const verifiable =
    input.evidence.length > 0 &&
    input.evidence.every((e) => (e.kind === 'file' || e.kind === 'test' ? Boolean(e.hash) : true));
  const autoActive = authority <= 1 && verifiable;
  const state: ClaimState = input.forceActive || (autoActive && !input.forceDraft) ? 'active' : 'draft';

  const author = input.author ?? 'human:cli';
  const writtenBy =
    input.writtenBy ?? (author.startsWith('agent:') ? 'agent' : author.startsWith('human:') ? 'human' : 'legacy');
  const agentId =
    input.agentId ?? (author.startsWith('agent:') ? author.slice('agent:'.length).split('/')[0] : null);
  // Trust is orthogonal to branch membership: only an active, actually observed
  // claim is canonical. A forced-active claim with unhashable evidence stays a candidate.
  const trust: Trust = state === 'active' && verifiable ? 'canonical' : 'candidate';

  if (!existing) {
    db.prepare(
      `INSERT INTO claim(id, subject_id, predicate, object_json, valid_from, valid_to, tx_from,
                         authority, confidence, author, supersedes, state,
                         trust, ttl_days, last_verified_at, written_by, agent_id, session_id, run_id)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.subject,
      input.predicate,
      JSON.stringify(input.object),
      input.validFrom ?? null,
      now,
      authority,
      input.confidence ?? (authority <= 1 ? 0.95 : 0.6),
      author,
      input.supersedes ?? null,
      state,
      trust,
      input.ttlDays ?? null,
      now,
      writtenBy,
      agentId,
      input.sessionId ?? null,
      input.runId ?? null,
    );
  } else if (existing.state === 'draft' && state === 'active') {
    db.prepare(
      `UPDATE claim SET state = 'active', authority = ?, confidence = ?, trust = ?,
                        last_verified_at = ? WHERE id = ?`,
    ).run(authority, input.confidence ?? 0.95, trust, now, id);
  }

  for (const ev of input.evidence) {
    db.prepare(
      `INSERT INTO evidence(claim_id, kind, ref, hash, commit_id, verified_at, status)
       VALUES (?, ?, ?, ?, ?, ?, 'valid')
       ON CONFLICT(claim_id, kind, ref) DO UPDATE SET
         hash = COALESCE(excluded.hash, evidence.hash),
         commit_id = COALESCE(excluded.commit_id, evidence.commit_id),
         verified_at = excluded.verified_at,
         status = 'valid'`,
    ).run(id, ev.kind, ev.ref, ev.hash ?? null, ev.commit ?? null, now);
  }

  // Drafts are not injected, so only an active write can contest live memory.
  if (state === 'active') runClaimWriteHooks(db, id);

  return { id, inserted: !existing, state, authority };
}

export interface SupersedeInput {
  object: string;
  evidence: EvidenceInput[];
  confidence?: number;
  author?: string;
  ttlDays?: number | null;
  writtenBy?: 'agent' | 'human' | 'legacy';
  agentId?: string | null;
  sessionId?: string | null;
  runId?: string | null;
}

/**
 * Replace a claim with a new version. The old row keeps its history but gains a
 * valid_to timestamp, and the branch fold removes it via the supersede op.
 */
export function supersedeClaim(
  db: DB,
  oldId: string,
  input: SupersedeInput,
): { oldId: string; newId: string; state: ClaimState; authority: number } {
  const old = db.prepare('SELECT * FROM claim WHERE id = ?').get(oldId) as ClaimRow | undefined;
  if (!old) throw new Error(`no such claim: ${oldId}`);

  const result = upsertClaim(db, {
    subject: old.subject_id,
    predicate: old.predicate,
    object: input.object,
    evidence: input.evidence,
    confidence: input.confidence,
    author: input.author,
    supersedes: oldId,
    ttlDays: input.ttlDays,
    writtenBy: input.writtenBy,
    agentId: input.agentId,
    sessionId: input.sessionId,
    runId: input.runId,
  });

  if (result.id === oldId) {
    throw new Error('the new object is identical to the current claim');
  }

  db.prepare('UPDATE claim SET valid_to = ? WHERE id = ?').run(new Date().toISOString(), oldId);
  return { oldId, newId: result.id, state: result.state, authority: result.authority };
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

/** Fold commit entries from the DAG root(s) to tip. Parents always apply before children. */
function applyEntries(
  db: DB,
  set: Map<string, string>,
  entries: Array<{ claim_id: string; op: string }>,
): void {
  const supersededBy = db.prepare('SELECT supersedes FROM claim WHERE id = ?');
  for (const e of entries) {
    if (e.op === 'retract') {
      set.delete(e.claim_id);
      continue;
    }
    if (e.op === 'supersede') {
      const row = supersededBy.get(e.claim_id) as { supersedes: string | null } | undefined;
      if (row?.supersedes) set.delete(row.supersedes);
    }
    set.set(e.claim_id, e.op);
  }
}

export function activeAt(db: DB, commitId: string | null): Map<string, string> {
  return activeAtAsOf(db, commitId, Number.POSITIVE_INFINITY);
}

/**
 * Active set at a transaction-time instant.
 *
 * The whole ancestry is walked (a commit newer than the instant is skipped, but
 * its parents are still visited), then only commits at or before the instant are
 * applied in topological order. Pruning the walk at the instant would hide facts
 * that lived on a sibling branch before the merge that joined them.
 */
export function activeAtAsOf(
  db: DB,
  commitId: string | null,
  instantMs: number,
): Map<string, string> {
  if (!commitId) return new Map();

  const order: Array<{ id: string; ts: number }> = [];
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    const row = db
      .prepare('SELECT ts, parent_id, merge_parent_id FROM memory_commit WHERE id = ?')
      .get(id) as { ts: string; parent_id: string | null; merge_parent_id: string | null } | undefined;
    if (!row) return;
    if (row.parent_id) visit(row.parent_id);
    if (row.merge_parent_id) visit(row.merge_parent_id);
    order.push({ id, ts: Date.parse(row.ts) });
  };
  visit(commitId);

  const set = new Map<string, string>();
  for (const c of order) {
    if (c.ts > instantMs) continue;
    const entries = db
      .prepare('SELECT claim_id, op FROM commit_entry WHERE commit_id = ? ORDER BY rowid')
      .all(c.id) as Array<{ claim_id: string; op: string }>;
    applyEntries(db, set, entries);
  }
  return set;
}

export function inBranch(db: DB, ref: string, claimId: string): boolean {
  return activeAt(db, head(db, ref) ?? head(db, 'main')).has(claimId);
}

export interface CommitInput {
  ref: string;
  entries: Array<{ claim_id: string; op: 'add' | 'supersede' | 'retract' | 'restore' }>;
  message: string;
  author: string;
  kind: 'init' | 'write' | 'merge' | 'revert' | 'gc' | 'import';
  /** Second parent: the branch that was merged in. Makes the history a real DAG. */
  mergeParent?: string | null;
}

export function makeCommit(db: DB, input: CommitInput): string {
  const parent = resolveHead(db, input.ref);
  const set = activeAt(db, parent);
  applyEntries(db, set, input.entries);
  const tree = treeHash([...set.entries()].map(([claim_id, op]) => ({ claim_id, op })));
  const ts = new Date().toISOString();
  const id = `k_${sha256(`${parent ?? 'root'}|${tree}|${input.message}|${input.author}|${ts}`).slice(0, 32)}`;

  db.prepare(
    'INSERT INTO memory_commit(id, parent_id, merge_parent_id, tree_hash, message, author, ts, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, parent, input.mergeParent ?? null, tree, input.message, input.author, ts, input.kind);

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
  valid_to: string | null;
  tx_from: string;
  authority: number;
  confidence: number;
  author: string;
  state: ClaimState;
  supersedes: string | null;
  trust: Trust;
  ttl_days: number | null;
  last_verified_at: string | null;
  confirmations: number;
  contradictions: number;
  written_by: string;
  agent_id: string | null;
  session_id: string | null;
  run_id: string | null;
  tags_json: string;
  invalidated_by_json: string | null;
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

