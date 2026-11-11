import type { DB } from './db.js';

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

interface DraftRow {
  id: string;
  subject_id: string;
  predicate: string;
  tx_from: string;
}

/**
 * SPEC §6: drafts unused for `ttl_sessions` are retracted.
 *
 * "Used" means a human looked at it (blame), because drafts are deliberately
 * invisible to retrieval until approved. Sessions are registered by any command,
 * so the count reflects real work, not wall-clock time.
 */
export function gcCandidates(db: DB, policy: GcPolicy): GcCandidate[] {
  const drafts = db
    .prepare("SELECT id, subject_id, predicate, tx_from FROM claim WHERE state = 'draft'")
    .all() as DraftRow[];
  if (!drafts.length) return [];

  if (policy.ttlDays !== undefined) {
    const cutoff = new Date(Date.now() - policy.ttlDays * 86_400_000).toISOString();
    return drafts
      .filter((d) => d.tx_from < cutoff)
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
    const later = sessions.filter((s) => s.started_at > draft.tx_from);
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
