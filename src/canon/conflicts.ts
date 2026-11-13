import type { DB } from '../db.js';
import type { ClaimRow, Trust } from '../model.js';
import { loadOntology } from '../ontology.js';

export interface Tier1Conflict {
  subject: string;
  predicate: string;
  claim: string;
  rival: string;
}

/** Trust states that still assert a value in the branch. */
const LIVE_TRUST: Trust[] = ['canonical', 'candidate', 'contested'];

const REASON = 'tier-1: two live claims assert different values for a one-valued predicate';

/**
 * Tier-1 conflict detection: same (subject, predicate), different object, and the
 * predicate allows only one value. Both sides become contested and one row is
 * recorded. Deterministic, synchronous, no model in the loop.
 *
 * Drafts are skipped because they are never injected; approval runs the hook again.
 * Superseded claims (valid_to set, or linked by supersedes) are history, not rivals.
 */
export function detectTier1Conflicts(db: DB, root: string, claimId: string): Tier1Conflict[] {
  const claim = db.prepare('SELECT * FROM claim WHERE id = ?').get(claimId) as ClaimRow | undefined;
  if (!claim || claim.state !== 'active' || claim.valid_to) return [];
  if (!LIVE_TRUST.includes(claim.trust)) return [];
  if (loadOntology(root).cardinality(claim.predicate) === 'many') return [];

  const rivals = (
    db
      .prepare(
        `SELECT * FROM claim
         WHERE subject_id = ? AND predicate = ? AND id <> ? AND object_json <> ?
           AND state = 'active' AND valid_to IS NULL
           AND trust IN ('canonical','candidate','contested')`,
      )
      .all(claim.subject_id, claim.predicate, claim.id, claim.object_json) as ClaimRow[]
  ).filter((rival) => rival.id !== claim.supersedes && claim.id !== rival.supersedes);

  const apply = db.transaction((): Tier1Conflict[] => {
    const found: Tier1Conflict[] = [];
    const now = new Date().toISOString();
    // Sorted ids keep the pair stable whichever side was written first.
    const insert = db.prepare(
      `INSERT INTO claim_conflict(subject_id, predicate, left_claim, right_claim, tier, reason, detected_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(left_claim, right_claim) DO UPDATE SET
         resolved = 0, resolved_by = NULL, detected_at = excluded.detected_at
       WHERE claim_conflict.resolved = 1`,
    );
    const contest = db.prepare(
      `UPDATE claim SET trust = 'contested', contradictions = contradictions + 1
       WHERE id = ? AND trust <> 'retracted'`,
    );

    for (const rival of rivals) {
      const [left, right] = claim.id < rival.id ? [claim.id, rival.id] : [rival.id, claim.id];
      const recorded = insert.run(claim.subject_id, claim.predicate, left, right, REASON, now);
      // No change means this pair was already recorded and is still open.
      if (!recorded.changes) continue;
      contest.run(left);
      contest.run(right);
      found.push({
        subject: claim.subject_id,
        predicate: claim.predicate,
        claim: claim.id,
        rival: rival.id,
      });
    }
    return found;
  });

  return apply();
}
