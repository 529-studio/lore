import type { DB } from '../db.js';
import type { ClaimRow } from '../model.js';
import { loadOntology } from '../ontology.js';
import { searchMemory } from '../retrieval.js';
import { branchFor, currentSession } from '../session.js';
import { explainTarget } from './explain.js';

export interface CanonMetrics {
  schema: 1;
  generated_at: string;
  branch: string;
  totals: { claims: number; injected: number };
  metrics: {
    stale_injection_rate: number;
    conflict_detection_precision: number;
    explain_coverage: number;
    candidate_to_canonical_median_hours: number;
    first_try_failure_rate: number;
  };
  samples: {
    injected: number;
    conflicts: number;
    explained: number;
    canonical: number;
  };
  definitions: Record<string, string>;
}

const SAMPLE_LIMIT = 50;

function ratio(numerator: number, denominator: number, empty = 1): number {
  return denominator > 0 ? numerator / denominator : empty;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Metrics measured through the real retrieval path, not a private shortcut.
 * Empty denominators return the benign value and record the sample size, so a
 * fresh repository does not divide by zero.
 */
export function canonMetrics(db: DB, root: string): CanonMetrics {
  const { hits } = searchMemory(db, root, { budgetTokens: 1_000_000 });
  const injected = hits.length;
  const staleInjected = hits.filter((h) => h.stale).length;

  // Precision: a sampled open pair is valid when both claims still exist, the
  // key matches, the values differ, and the predicate is one-valued.
  const pairs = db
    .prepare('SELECT subject_id, predicate, left_claim, right_claim FROM claim_conflict WHERE resolved = 0 ORDER BY id LIMIT ?')
    .all(SAMPLE_LIMIT) as Array<{
    subject_id: string;
    predicate: string;
    left_claim: string;
    right_claim: string;
  }>;
  const ontology = loadOntology(root);
  const claimStmt = db.prepare('SELECT * FROM claim WHERE id = ?');
  let validPairs = 0;
  for (const pair of pairs) {
    const left = claimStmt.get(pair.left_claim) as ClaimRow | undefined;
    const right = claimStmt.get(pair.right_claim) as ClaimRow | undefined;
    if (!left || !right) continue;
    if (left.subject_id !== pair.subject_id || right.subject_id !== pair.subject_id) continue;
    if (left.predicate !== pair.predicate || right.predicate !== pair.predicate) continue;
    if (left.object_json === right.object_json) continue;
    if (ontology.cardinality(pair.predicate) !== 'one') continue;
    validPairs += 1;
  }

  // Coverage: every injected claim must be explainable with a reason.
  let explained = 0;
  for (const hit of hits.slice(0, SAMPLE_LIMIT)) {
    try {
      const result = explainTarget(db, root, hit.claim.id);
      if (result.claims[0]?.trust_reason) explained += 1;
    } catch {
      // unparseable provenance counts as uncovered
    }
  }

  // Candidate -> canonical latency: approval (or first observation) minus tx_from.
  const canonical = db
    .prepare(
      `SELECT tx_from, last_verified_at FROM claim
       WHERE trust = 'canonical' AND last_verified_at IS NOT NULL
       ORDER BY tx_from`,
    )
    .all() as Array<{ tx_from: string; last_verified_at: string }>;
  const delays: number[] = [];
  for (const row of canonical) {
    const start = Date.parse(row.tx_from);
    const end = Date.parse(row.last_verified_at);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      delays.push((end - start) / 3_600_000);
    }
  }

  // First-try failure: memory that had to be retracted or purged.
  const claims = (db.prepare('SELECT COUNT(*) n FROM claim').get() as { n: number }).n;
  const retracted = (db.prepare("SELECT COUNT(*) n FROM claim WHERE state = 'retracted'").get() as { n: number }).n;
  const purged = (db.prepare('SELECT COUNT(*) n FROM purge_audit').get() as { n: number }).n;
  const everWritten = claims + purged;

  return {
    schema: 1,
    generated_at: new Date().toISOString(),
    branch: branchFor(currentSession(root)),
    totals: { claims, injected },
    metrics: {
      stale_injection_rate: round(ratio(staleInjected, injected, 0)),
      conflict_detection_precision: round(ratio(validPairs, pairs.length, 1)),
      explain_coverage: round(ratio(explained, Math.min(injected, SAMPLE_LIMIT), 1)),
      candidate_to_canonical_median_hours: round(median(delays), 3),
      first_try_failure_rate: round(ratio(retracted + purged, everWritten, 0)),
    },
    samples: {
      injected,
      conflicts: pairs.length,
      explained: Math.min(injected, SAMPLE_LIMIT),
      canonical: canonical.length,
    },
    definitions: {
      stale_injection_rate: 'stale hits returned by the default search / all injected hits (lower is better)',
      conflict_detection_precision:
        'sampled open pairs that are same-key, different-value and cardinality one / sampled pairs (50 max)',
      explain_coverage: 'injected claims whose trust reason explain can state / injected claims sampled (50 max)',
      candidate_to_canonical_median_hours:
        'median hours from tx_from to last_verified_at for canonical claims (approval or first observation)',
      first_try_failure_rate: 'retracted claims plus purges / claims ever written (lower is better)',
    },
  };
}
