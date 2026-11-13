import type { DB } from '../db.js';
import type { Principal } from '../identity.js';
import { inBranch, makeCommit, type ClaimRow, type Trust } from '../model.js';
import { gitHead } from '../util/git.js';

export interface ResolveResult {
  subject: string;
  predicate: string;
  keep: string;
  winner_trust: Trust;
  losers: string[];
  resolved_conflicts: number;
  commit: string | null;
}

function restoreSurvivor(db: DB, claimId: string): void {
  const claim = db.prepare('SELECT * FROM claim WHERE id = ?').get(claimId) as ClaimRow | undefined;
  if (!claim || claim.state !== 'active' || claim.trust !== 'contested') return;
  const open = (
    db
      .prepare(
        `SELECT COUNT(*) n FROM claim_conflict
         WHERE resolved = 0 AND (left_claim = ? OR right_claim = ?)`,
      )
      .get(claimId, claimId) as { n: number }
  ).n;
  if (open) return;
  const evidence = (
    db.prepare('SELECT COUNT(*) n FROM evidence WHERE claim_id = ?').get(claimId) as { n: number }
  ).n;
  const trust: Trust = evidence > 0 ? 'canonical' : 'candidate';
  db.prepare(
    `UPDATE claim SET trust = ?, last_verified_at = COALESCE(last_verified_at, ?),
                      invalidated_by_json = NULL
     WHERE id = ?`,
  ).run(trust, new Date().toISOString(), claimId);
}

/**
 * A retracted claim stops contesting live memory. Close its open conflicts and,
 * when the survivor has no other conflict, restore it to canonical/candidate so
 * the fact is not silently lost forever.
 */
export function closeConflictsForClaim(db: DB, claimId: string, actor: string): number {
  const rows = db
    .prepare('SELECT id, left_claim, right_claim FROM claim_conflict WHERE resolved = 0 AND (left_claim = ? OR right_claim = ?)')
    .all(claimId, claimId) as Array<{ id: number; left_claim: string; right_claim: string }>;
  if (!rows.length) return 0;

  const close = db.prepare('UPDATE claim_conflict SET resolved = 1, resolved_by = ? WHERE id = ?');
  const run = db.transaction(() => {
    for (const row of rows) {
      close.run(actor, row.id);
      restoreSurvivor(db, row.left_claim === claimId ? row.right_claim : row.left_claim);
    }
  });
  run();
  return rows.length;
}

/**
 * Human resolution of a tier-1 conflict: keep one claim, retract the others,
 * close every open conflict on that fact key. Gated by the caller with the
 * `resolve` policy action.
 */
export function resolveFact(
  db: DB,
  root: string,
  ref: string,
  subject: string,
  predicate: string,
  keepId: string,
  principal: Principal,
  reason?: string,
): ResolveResult {
  const rows = db
    .prepare('SELECT * FROM claim WHERE subject_id = ? AND predicate = ? ORDER BY tx_from DESC')
    .all(subject, predicate) as ClaimRow[];
  if (!rows.length) throw new Error(`no claims for ${subject}:${predicate}`);

  const winner = rows.find((row) => row.id === keepId);
  if (!winner) throw new Error(`claim ${keepId} is not a ${subject}:${predicate} claim`);
  if (winner.state === 'retracted' || winner.trust === 'retracted') {
    throw new Error(`claim ${keepId} is retracted and cannot be the winner`);
  }

  const losers = rows.filter(
    (row) => row.id !== keepId && row.state === 'active' && row.trust !== 'retracted',
  );
  if (!losers.length) throw new Error(`no competing claim to retract for ${subject}:${predicate}`);

  const actor = `human:${principal.id}`;
  const now = new Date().toISOString();
  const inBranchLosers = losers.filter((row) => inBranch(db, ref, row.id));
  let commit: string | null = null;
  let resolvedCount = 0;

  db.transaction(() => {
    db.prepare(
      `INSERT INTO evidence(claim_id, kind, ref, hash, commit_id, verified_at, status)
       VALUES (?, 'human', ?, NULL, ?, ?, 'valid')
       ON CONFLICT(claim_id, kind, ref) DO UPDATE SET
         commit_id = COALESCE(excluded.commit_id, evidence.commit_id),
         verified_at = excluded.verified_at,
         status = 'valid'`,
    ).run(keepId, `resolve:${principal.id}`, gitHead(root), now);

    db.prepare(
      `UPDATE claim SET trust = 'canonical', last_verified_at = ?, invalidated_by_json = NULL,
                        confirmations = confirmations + 1
       WHERE id = ?`,
    ).run(now, keepId);

    const resolved = db
      .prepare(
        `UPDATE claim_conflict SET resolved = 1, resolved_by = ?
         WHERE resolved = 0 AND subject_id = ? AND predicate = ?`,
      )
      .run(actor, subject, predicate).changes;
    resolvedCount = resolved;

    const retract = db.prepare("UPDATE claim SET state = 'retracted', trust = 'retracted' WHERE id = ?");
    for (const loser of losers) retract.run(loser.id);

    if (inBranchLosers.length) {
      commit = makeCommit(db, {
        ref,
        entries: inBranchLosers.map((row) => ({ claim_id: row.id, op: 'retract' as const })),
        message: `canon resolve: keep ${keepId} for ${subject}:${predicate}${reason ? ` (${reason})` : ''}`,
        author: actor,
        kind: 'write',
      });
    }
  })();

  return {
    subject,
    predicate,
    keep: keepId,
    winner_trust: 'canonical',
    losers: losers.map((row) => row.id),
    resolved_conflicts: resolvedCount,
    commit,
  };
}
