import type { DB } from '../db.js';
import type { Trust } from '../model.js';

export interface CanonStatus {
  trust: Record<Trust, number>;
  total: number;
  unresolved_conflicts: number;
  contested_facts: number;
}

export const TRUST_ORDER: Trust[] = ['canonical', 'candidate', 'contested', 'stale', 'retracted'];

export function canonStatus(db: DB): CanonStatus {
  const trust: Record<Trust, number> = {
    canonical: 0,
    candidate: 0,
    contested: 0,
    stale: 0,
    retracted: 0,
  };
  const rows = db.prepare('SELECT trust, COUNT(*) n FROM claim GROUP BY trust').all() as Array<{
    trust: Trust;
    n: number;
  }>;
  let total = 0;
  for (const row of rows) {
    if (row.trust in trust) trust[row.trust] = row.n;
    total += row.n;
  }

  const unresolved = (
    db
      .prepare(
        `SELECT COUNT(*) n FROM claim_conflict cc
         JOIN claim l ON l.id = cc.left_claim
         JOIN claim r ON r.id = cc.right_claim
         WHERE cc.resolved = 0 AND l.state = 'active' AND r.state = 'active'
           AND l.trust = 'contested' AND r.trust = 'contested'`,
      )
      .get() as { n: number }
  ).n;
  const facts = (
    db
      .prepare(
        `SELECT COUNT(*) n FROM (
           SELECT DISTINCT cc.subject_id, cc.predicate FROM claim_conflict cc
           JOIN claim l ON l.id = cc.left_claim
           JOIN claim r ON r.id = cc.right_claim
           WHERE cc.resolved = 0 AND l.state = 'active' AND r.state = 'active'
             AND l.trust = 'contested' AND r.trust = 'contested'
         )`,
      )
      .get() as { n: number }
  ).n;

  return { trust, total, unresolved_conflicts: unresolved, contested_facts: facts };
}
