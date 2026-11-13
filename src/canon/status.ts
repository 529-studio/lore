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
    db.prepare('SELECT COUNT(*) n FROM claim_conflict WHERE resolved = 0').get() as { n: number }
  ).n;
  const facts = (
    db
      .prepare(
        `SELECT COUNT(*) n FROM (
           SELECT DISTINCT subject_id, predicate FROM claim_conflict WHERE resolved = 0
         )`,
      )
      .get() as { n: number }
  ).n;

  return { trust, total, unresolved_conflicts: unresolved, contested_facts: facts };
}
