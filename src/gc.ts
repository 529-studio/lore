import type { DB } from './db.js';
import { runClaimRetractHooks } from './model.js';

export interface GcPolicy {
  /** Retract a draft nobody reviewed for this many sessions. */
  ttlSessions: number;
  /** Explicit override: age in days, used when session history is not available. */
  ttlDays?: number;
}

export interface GcCandidate {
  id: string;
  subject: string;
  predicate: string;
  tx_from: string;
  reason: string;
}

export interface TombstoneCandidate {
  id: string;
  subject: string;
  predicate: string;
  retracted_at: string;
  reason: string;
}

export interface TombstonePolicy {
  tombstoneTtlDays?: number;
  tombstoneTtlSessions?: number;
}

export interface DatabaseStorageStats {
  pageSize: number;
  pageCount: number;
  freelistPages: number;
  freelistBytes: number;
  totalBytes: number;
}

export interface DatabaseCompactionResult {
  before: DatabaseStorageStats;
  after: DatabaseStorageStats;
  reclaimedBytes: number;
  reclaimedPages: number;
}

interface DraftRow {
  id: string;
  subject_id: string;
  predicate: string;
  tx_from: string;
  session_id: string | null;
  /** Last time this draft was observed/written; never earlier than tx_from. */
  observed_at: string;
}

/**
 * SPEC §6: drafts unused for `ttl_sessions` are retracted.
 *
 * "Used" means a human looked at it (blame), because drafts are deliberately
 * invisible to retrieval until approved. Sessions are registered by any command,
 * so the count reflects real work, not wall-clock time.
 *
 * Distance is measured from the draft's *last observation*, not its row
 * creation. Writing the same claim again updates evidence.verified_at, so an
 * active agent re-observing a draft resets its age instead of inheriting a
 * tx_from from a row inserted days ago. The session that wrote the draft is
 * excluded from the count: it cannot be a later session.
 */
export function gcCandidates(db: DB, policy: GcPolicy): GcCandidate[] {
  const drafts = db
    .prepare(
      `SELECT c.id, c.subject_id, c.predicate, c.tx_from, c.session_id,
              COALESCE((SELECT MAX(e.verified_at) FROM evidence e WHERE e.claim_id = c.id), c.tx_from)
                AS observed_at
       FROM claim c
       WHERE c.state = 'draft'`,
    )
    .all() as DraftRow[];
  if (!drafts.length) return [];

  if (policy.ttlDays !== undefined) {
    const cutoff = new Date(Date.now() - policy.ttlDays * 86_400_000).toISOString();
    return drafts
      .filter((d) => d.observed_at < cutoff)
      .map((d) => ({
        id: d.id,
        subject: d.subject_id,
        predicate: d.predicate,
        tx_from: d.tx_from,
        reason: `older than ${policy.ttlDays} day(s)`,
      }));
  }

  const sessions = db
    .prepare('SELECT id, started_at FROM session ORDER BY started_at ASC')
    .all() as Array<{ id: string; started_at: string }>;
  if (sessions.length < policy.ttlSessions) return [];

  const reads = db.prepare('SELECT session_id FROM claim_read WHERE claim_id = ?');
  const out: GcCandidate[] = [];

  for (const draft of drafts) {
    const later = sessions.filter(
      (s) => s.id !== draft.session_id && s.started_at > draft.observed_at,
    );
    if (later.length < policy.ttlSessions) continue;
    const window = later.slice(-policy.ttlSessions);
    const readIn = new Set((reads.all(draft.id) as Array<{ session_id: string }>).map((r) => r.session_id));
    if (window.some((s) => readIn.has(s.id))) continue;
    out.push({
      id: draft.id,
      subject: draft.subject_id,
      predicate: draft.predicate,
      tx_from: draft.tx_from,
      reason: `${policy.ttlSessions} session(s) without review`,
    });
  }

  return out;
}

/**
 * Identify retracted claims (tombstones) eligible for permanent purging.
 */
export function tombstoneCandidates(db: DB, policy: TombstonePolicy = {}): TombstoneCandidate[] {
  const ttlDays = policy.tombstoneTtlDays ?? 30;
  const rows = db
    .prepare("SELECT id, subject_id, predicate, tx_from FROM claim WHERE state = 'retracted' OR trust = 'retracted'")
    .all() as Array<{ id: string; subject_id: string; predicate: string; tx_from: string }>;
  if (!rows.length) return [];

  const logStmt = db.prepare(
    "SELECT ts FROM agent_action_log WHERE table_name = 'claim' AND row_id = ? AND action = 'UPDATE' ORDER BY ts DESC LIMIT 1",
  );
  const commitStmt = db.prepare(
    "SELECT mc.ts FROM commit_entry ce JOIN memory_commit mc ON ce.commit_id = mc.id WHERE ce.claim_id = ? AND ce.op = 'retract' ORDER BY mc.ts DESC LIMIT 1",
  );

  const cutoff = ttlDays === 0 ? new Date().toISOString() : new Date(Date.now() - ttlDays * 86_400_000).toISOString();
  const out: TombstoneCandidate[] = [];

  for (const row of rows) {
    const logRow = logStmt.get(row.id) as { ts: string } | undefined;
    const commitRow = commitStmt.get(row.id) as { ts: string } | undefined;
    const retractedAt = logRow?.ts ?? commitRow?.ts ?? row.tx_from;

    if (ttlDays === 0 || retractedAt <= cutoff) {
      out.push({
        id: row.id,
        subject: row.subject_id,
        predicate: row.predicate,
        retracted_at: retractedAt,
        reason: ttlDays === 0 ? 'immediate tombstone purge' : `retracted >= ${ttlDays} day(s) ago`,
      });
    }
  }

  return out;
}

/**
 * Permanently purge eligible tombstones, deleting dependent foreign key rows
 * and unlinking supersedes pointers while logging to purge_audit.
 */
export function purgeTombstones(db: DB, candidates: TombstoneCandidate[], actor: string = 'lore:gc'): number {
  if (!candidates.length) return 0;

  const now = new Date().toISOString();
  const deleteClaimRead = db.prepare('DELETE FROM claim_read WHERE claim_id = ?');
  const deleteCommitEntry = db.prepare('DELETE FROM commit_entry WHERE claim_id = ?');
  const deleteEvidence = db.prepare('DELETE FROM evidence WHERE claim_id = ?');
  const clearSupersedes = db.prepare('UPDATE claim SET supersedes = NULL WHERE supersedes = ?');
  const deleteRedaction = db.prepare('DELETE FROM redaction WHERE claim_id = ?');
  const deleteAttestation = db.prepare('DELETE FROM attestation WHERE claim_id = ? OR attestation_claim_id = ?');
  const deleteClaim = db.prepare('DELETE FROM claim WHERE id = ?');
  const insertAudit = db.prepare(
    'INSERT INTO purge_audit (claim_id, actor, reason, ts) VALUES (?, ?, ?, ?) ON CONFLICT(claim_id) DO NOTHING',
  );

  const apply = db.transaction(() => {
    for (const c of candidates) {
      runClaimRetractHooks(db, c.id, actor);
      deleteClaimRead.run(c.id);
      deleteCommitEntry.run(c.id);
      deleteEvidence.run(c.id);
      clearSupersedes.run(c.id);
      deleteRedaction.run(c.id);
      deleteAttestation.run(c.id, c.id);
      deleteClaim.run(c.id);
      insertAudit.run(c.id, actor, `gc tombstone: ${c.reason}`, now);
    }
  });

  apply();
  return candidates.length;
}

/**
 * Retrieve low-level SQLite storage and freelist metrics.
 */
export function getDatabaseStorageStats(db: DB): DatabaseStorageStats {
  const pageSize = (db.pragma('page_size', { simple: true }) as number) ?? 4096;
  const pageCount = (db.pragma('page_count', { simple: true }) as number) ?? 0;
  const freelistPages = (db.pragma('freelist_count', { simple: true }) as number) ?? 0;

  return {
    pageSize,
    pageCount,
    freelistPages,
    freelistBytes: freelistPages * pageSize,
    totalBytes: pageCount * pageSize,
  };
}

/**
 * Defragment and compact SQLite database pages via VACUUM outside any transaction.
 */
export function compactDatabase(db: DB): DatabaseCompactionResult {
  const before = getDatabaseStorageStats(db);
  db.exec('VACUUM');
  const after = getDatabaseStorageStats(db);

  return {
    before,
    after,
    reclaimedBytes: Math.max(0, before.totalBytes - after.totalBytes),
    reclaimedPages: Math.max(0, before.pageCount - after.pageCount),
  };
}
