import type { DB } from './db.js';
import { hashFile } from './extract/index.js';
import type { ClaimRow } from './model.js';
import type { Ontology } from './ontology.js';
import { activeAt } from './model.js';

export interface Decision {
  subject: string;
  predicate: string;
  winner: string | null;
  loser: string | null;
  rule: string;
  reason: string;
}

export interface Conflict {
  subject: string;
  predicate: string;
  ours: ClaimRow | null;
  theirs: ClaimRow | null;
  base: ClaimRow | null;
  reason: string;
}

export interface MergePlan {
  baseCommit: string | null;
  oursTip: string | null;
  theirsTip: string | null;
  mode: 'up-to-date' | 'fast-forward' | 'three-way' | 'conflict';
  add: string[];
  retract: string[];
  decisions: Decision[];
  conflicts: Conflict[];
}

const SEP = '\u0000';
const keyOf = (c: ClaimRow) => `${c.subject_id}${SEP}${c.predicate}`;

function loadClaims(db: DB, ids: string[]): ClaimRow[] {
  const stmt = db.prepare('SELECT * FROM claim WHERE id = ?');
  const out: ClaimRow[] = [];
  for (const id of ids) {
    const row = stmt.get(id) as ClaimRow | undefined;
    if (row) out.push(row);
  }
  return out;
}

/** One current claim per (subject, predicate): drop superseded, then newest. */
export function byKey(claims: ClaimRow[]): Map<string, ClaimRow> {
  const grouped = new Map<string, ClaimRow[]>();
  for (const c of claims) {
    const key = keyOf(c);
    const list = grouped.get(key) ?? [];
    list.push(c);
    grouped.set(key, list);
  }

  const out = new Map<string, ClaimRow>();
  for (const [key, list] of grouped) {
    const superseded = new Set(list.map((c) => c.supersedes).filter((x): x is string => Boolean(x)));
    let candidates = list.filter((c) => !superseded.has(c.id));
    if (!candidates.length) candidates = list;
    candidates.sort((a, b) => {
      if (a.tx_from !== b.tx_from) return a.tx_from < b.tx_from ? 1 : -1;
      return a.id.localeCompare(b.id);
    });
    out.set(key, candidates[0]);
  }
  return out;
}

export function isStale(db: DB, root: string, claimId: string): boolean {
  const rows = db
    .prepare(
      `SELECT ref, hash FROM evidence
       WHERE claim_id = ? AND kind IN ('file','test') AND hash IS NOT NULL`,
    )
    .all(claimId) as Array<{ ref: string; hash: string }>;
  return rows.some((r) => hashFile(root, r.ref) !== r.hash);
}

/** Lowest common ancestor over the commit DAG. */
export function lca(db: DB, a: string | null, b: string | null): string | null {
  if (!a || !b) return null;
  const depth = new Map<string, number>();
  let cursor: string | null = a;
  let d = 0;
  while (cursor && !depth.has(cursor)) {
    depth.set(cursor, d++);
    const row = db.prepare('SELECT parent_id FROM memory_commit WHERE id = ?').get(cursor) as
      | { parent_id: string | null }
      | undefined;
    cursor = row?.parent_id ?? null;
  }
  cursor = b;
  while (cursor) {
    if (depth.has(cursor)) return cursor;
    const row = db.prepare('SELECT parent_id FROM memory_commit WHERE id = ?').get(cursor) as
      | { parent_id: string | null }
      | undefined;
    cursor = row?.parent_id ?? null;
  }
  return null;
}

export interface MergeOptions {
  strategy: 'authority' | 'recency';
  strict: boolean;
  pendingResolution: Map<string, 'ours' | 'theirs' | 'both'>;
  ontology: Ontology;
}

export function planMerge(
  db: DB,
  root: string,
  oursTip: string | null,
  theirsTip: string | null,
  opts: MergeOptions,
): MergePlan {
  const baseCommit = lca(db, oursTip, theirsTip);
  const plan: MergePlan = {
    baseCommit,
    oursTip,
    theirsTip,
    mode: 'three-way',
    add: [],
    retract: [],
    decisions: [],
    conflicts: [],
  };

  if (oursTip === theirsTip) {
    plan.mode = 'up-to-date';
    return plan;
  }
  if (baseCommit === oursTip) {
    plan.mode = 'fast-forward';
    return plan;
  }
  if (baseCommit === theirsTip) {
    plan.mode = 'up-to-date';
    return plan;
  }

  const base = byKey(loadClaims(db, [...activeAt(db, baseCommit).keys()]));
  const ours = byKey(loadClaims(db, [...activeAt(db, oursTip).keys()]));
  const theirs = byKey(loadClaims(db, [...activeAt(db, theirsTip).keys()]));

  const keys = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const result = new Map<string, string[]>();
  const oursIds = new Set([...ours.values()].map((c) => c.id));
  const staleCache = new Map<string, boolean>();

  const stale = (c: ClaimRow | undefined): boolean => {
    if (!c) return false;
    if (!staleCache.has(c.id)) staleCache.set(c.id, isStale(db, root, c.id));
    return staleCache.get(c.id)!;
  };

  const resolve = (key: string, b: ClaimRow | undefined, o: ClaimRow | undefined, t: ClaimRow | undefined): void => {
    const subject = (o ?? t ?? b)!.subject_id;
    const predicate = (o ?? t ?? b)!.predicate;
    const pending = opts.pendingResolution.get(key);

    if (pending === 'both') {
      result.set(key, [o?.id, t?.id].filter((x): x is string => Boolean(x)));
      plan.decisions.push({ subject, predicate, winner: null, loser: null, rule: 'human', reason: 'resolve --take both' });
      return;
    }
    if (pending === 'ours' && o) {
      result.set(key, [o.id]);
      plan.decisions.push({ subject, predicate, winner: o.id, loser: t?.id ?? null, rule: 'human', reason: 'resolve --take ours' });
      return;
    }
    if (pending === 'theirs' && t) {
      result.set(key, [t.id]);
      plan.decisions.push({ subject, predicate, winner: t.id, loser: o?.id ?? null, rule: 'human', reason: 'resolve --take theirs' });
      return;
    }

    // R1 — predicate may hold several values: keep both.
    if (o && t && opts.ontology.cardinality(predicate) === 'many') {
      result.set(key, [o.id, t.id]);
      plan.decisions.push({ subject, predicate, winner: null, loser: null, rule: 'cardinality_many', reason: `${predicate} cardinality=many` });
      return;
    }

    const tierOf = (c: ClaimRow | undefined) => (c ? c.authority : Number.POSITIVE_INFINITY);
    const byAuthority = (): boolean => {
      if (!o || !t) return false;
      if (tierOf(o) === tierOf(t)) return false;
      const [w, l] = tierOf(o) < tierOf(t) ? [o, t] : [t, o];
      result.set(key, [w.id]);
      plan.decisions.push({ subject, predicate, winner: w.id, loser: l.id, rule: 'authority', reason: `T${w.authority} beats T${l.authority}` });
      return true;
    };
    const byRecency = (): boolean => {
      if (!o || !t) return false;
      if (tierOf(o) !== tierOf(t)) return false;
      // Only let recency decide when at least one side is verified/approved.
      if (opts.strict || tierOf(o) > 2) return false;
      const [w, l] = o.tx_from >= t.tx_from ? [o, t] : [t, o];
      result.set(key, [w.id]);
      plan.decisions.push({ subject, predicate, winner: w.id, loser: l.id, rule: 'recency', reason: `same tier T${w.authority}, newer wins` });
      return true;
    };

    const ladder = opts.strategy === 'recency' ? [byRecency, byAuthority] : [byAuthority, byRecency];

    // R2 / R5 in the configured order.
    for (const step of ladder) {
      if (step()) return;
    }

    // R3 — one side has valid evidence, the other drifted.
    if (o && t && stale(o) !== stale(t)) {
      const [w, l] = stale(o) ? [t, o] : [o, t];
      result.set(key, [w.id]);
      plan.decisions.push({ subject, predicate, winner: w.id, loser: l.id, rule: 'evidence_valid', reason: 'one side is stale' });
      return;
    }

    // R6 — do not guess.
    plan.conflicts.push({ subject, predicate, ours: o ?? null, theirs: t ?? null, base: b ?? null, reason: 'no rule applies (same tier, no verifiable evidence)' });
    result.set(key, ours.get(key) ? [ours.get(key)!.id] : []);
  };

  for (const key of keys) {
    const b = base.get(key);
    const o = ours.get(key);
    const t = theirs.get(key);
    const bi = b?.id;
    const oi = o?.id;
    const ti = t?.id;

    if (oi === ti) {
      if (oi) result.set(key, [oi]);
      continue;
    }
    if (oi === bi) {
      if (ti) result.set(key, [ti]);
      continue;
    }
    if (ti === bi) {
      if (oi) result.set(key, [oi]);
      continue;
    }
    resolve(key, b, o, t);
  }

  if (plan.conflicts.length) {
    plan.mode = 'conflict';
    return plan;
  }

  const finalIds = new Set([...result.values()].flat());
  plan.add = [...finalIds].filter((id) => !oursIds.has(id));
  plan.retract = [...oursIds].filter((id) => !finalIds.has(id));
  return plan;
}
