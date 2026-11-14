import type { DB } from './db.js';
import { hashCache } from './hash-cache.js';
import { gitHead, isGitAncestor } from './util/git.js';
import type { ClaimRow } from './model.js';
import { activeAt } from './model.js';
import type { Cardinality, Ontology } from './ontology.js';

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

/**
 * Merge unit = one fact.
 * cardinality one  → (subject, predicate)          two different objects conflict.
 * cardinality many → (subject, predicate, object)  several values coexist, so they never collide.
 */
export function factKey(c: ClaimRow, cardinality: (p: string) => Cardinality): string {
  const base = `${c.subject_id}${SEP}${c.predicate}`;
  return cardinality(c.predicate) === 'many' ? `${base}${SEP}${c.object_json}` : base;
}

export function loadClaims(db: DB, ids: string[]): ClaimRow[] {
  const stmt = db.prepare('SELECT * FROM claim WHERE id = ?');
  const out: ClaimRow[] = [];
  for (const id of ids) {
    const row = stmt.get(id) as ClaimRow | undefined;
    if (row) out.push(row);
  }
  return out;
}

/** Active claims of a commit: branch active set, drafts excluded. */
export function activeClaims(db: DB, tip: string | null): ClaimRow[] {
  return loadClaims(db, [...activeAt(db, tip).keys()]).filter((c) => c.state === 'active');
}

/** One current claim per fact key: drop superseded, then newest. */
export function byKey(
  claims: ClaimRow[],
  cardinality: (predicate: string) => Cardinality = () => 'one',
): Map<string, ClaimRow> {
  const grouped = new Map<string, ClaimRow[]>();
  for (const c of claims) {
    const key = factKey(c, cardinality);
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

export type Freshness = 'valid' | 'stale' | 'ahead';

/**
 * Distinguish "the file changed" from "my checkout is older than the claim".
 * The evidence records the git HEAD at observation time; if that commit is not an
 * ancestor of the current HEAD, the claim describes newer code than this checkout.
 */
export interface FreshnessOptions {
  head?: string | null;
}

export function claimFreshness(db: DB, root: string, claimId: string, options?: FreshnessOptions): Freshness {
  const rows = db
    .prepare(`SELECT ref, hash, commit_id FROM evidence WHERE claim_id = ? AND kind IN ('file','test')`)
    .all(claimId) as Array<{ ref: string; hash: string | null; commit_id: string | null }>;
  if (!rows.length) return 'valid';

  const cache = hashCache(db, root);
  const head = options?.head !== undefined ? options.head : gitHead(root);
  let ahead = false;

  for (const row of rows) {
    if (!row.hash) return 'stale';
    if (cache.hash(row.ref) === row.hash) continue;
    if (row.commit_id && head && !isGitAncestor(root, row.commit_id, head)) {
      ahead = true;
      continue;
    }
    return 'stale';
  }

  return ahead ? 'ahead' : 'valid';
}

/** Conservative: anything not valid locally (drifted or ahead) is untrusted for merge. */
export function isStale(db: DB, root: string, claimId: string, options?: FreshnessOptions): boolean {
  return claimFreshness(db, root, claimId, options) !== 'valid';
}

interface CommitParents {
  parent_id: string | null;
  merge_parent_id: string | null;
}

function parentsOf(db: DB, id: string): CommitParents | undefined {
  return db.prepare('SELECT parent_id, merge_parent_id FROM memory_commit WHERE id = ?').get(id) as
    | CommitParents
    | undefined;
}

/** Lowest common ancestor over the DAG (both parents). */
export function lca(db: DB, a: string | null, b: string | null): string | null {
  if (!a || !b) return null;

  const ancestors = new Map<string, number>();
  const queue: Array<[string, number]> = [[a, 0]];
  while (queue.length) {
    const [id, depth] = queue.shift()!;
    if (ancestors.has(id)) continue;
    ancestors.set(id, depth);
    const p = parentsOf(db, id);
    if (p?.parent_id) queue.push([p.parent_id, depth + 1]);
    if (p?.merge_parent_id) queue.push([p.merge_parent_id, depth + 1]);
  }

  const seen = new Set<string>();
  const fromB: Array<[string, number]> = [[b, 0]];
  let best: { id: string; depth: number } | null = null;
  while (fromB.length) {
    const [id, depth] = fromB.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    if (ancestors.has(id)) {
      const total = depth + (ancestors.get(id) ?? 0);
      if (!best || total < best.depth) best = { id, depth: total };
      continue;
    }
    const p = parentsOf(db, id);
    if (p?.parent_id) fromB.push([p.parent_id, depth + 1]);
    if (p?.merge_parent_id) fromB.push([p.merge_parent_id, depth + 1]);
  }
  return best?.id ?? null;
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

  const card = opts.ontology.cardinality;
  const base = byKey(activeClaims(db, baseCommit), card);
  const ours = byKey(activeClaims(db, oursTip), card);
  const theirs = byKey(activeClaims(db, theirsTip), card);

  const keys = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const result = new Map<string, string[]>();
  const oursIds = new Set([...ours.values()].map((c) => c.id));
  const theirsIds = new Set([...theirs.values()].map((c) => c.id));
  const baseIds = new Set([...base.values()].map((c) => c.id));
  const staleCache = new Map<string, boolean>();

  const stale = (c: ClaimRow | undefined): boolean => {
    if (!c) return false;
    if (!staleCache.has(c.id)) staleCache.set(c.id, isStale(db, root, c.id));
    return staleCache.get(c.id)!;
  };

  const resolve = (
    key: string,
    b: ClaimRow | undefined,
    o: ClaimRow | undefined,
    t: ClaimRow | undefined,
  ): void => {
    const anchor = (o ?? t ?? b)!;
    const subject = anchor.subject_id;
    const predicate = anchor.predicate;
    const pendingKey = `${subject}${SEP}${predicate}`;
    const pending = opts.pendingResolution.get(pendingKey);

    if (pending === 'both') {
      result.set(key, [o?.id, t?.id].filter((x): x is string => Boolean(x)));
      plan.decisions.push({ subject, predicate, winner: null, loser: null, rule: 'human', reason: 'resolve --take both' });
      return;
    }
    if (pending === 'ours') {
      result.set(key, o ? [o.id] : []);
      plan.decisions.push({ subject, predicate, winner: o?.id ?? null, loser: t?.id ?? null, rule: 'human', reason: 'resolve --take ours' });
      return;
    }
    if (pending === 'theirs') {
      result.set(key, t ? [t.id] : []);
      plan.decisions.push({ subject, predicate, winner: t?.id ?? null, loser: o?.id ?? null, rule: 'human', reason: 'resolve --take theirs' });
      return;
    }

    const tierOf = (c: ClaimRow | undefined) => (c ? c.authority : Number.POSITIVE_INFINITY);

    // R2 — authority tier wins.
    if (o && t && tierOf(o) !== tierOf(t)) {
      const [w, l] = tierOf(o) < tierOf(t) ? [o, t] : [t, o];
      result.set(key, [w.id]);
      plan.decisions.push({ subject, predicate, winner: w.id, loser: l.id, rule: 'authority', reason: `T${w.authority} beats T${l.authority}` });
      return;
    }

    // R3 — one side's evidence drifted, trust the other.
    if (o && t && stale(o) !== stale(t)) {
      const [w, l] = stale(o) ? [t, o] : [o, t];
      result.set(key, [w.id]);
      plan.decisions.push({ subject, predicate, winner: w.id, loser: l.id, rule: 'evidence_valid', reason: 'one side is stale' });
      return;
    }

    // R4 — delete vs edit: the deletion wins (safer), unless every present side is unverifiable.
    if (!o !== !t && b) {
      const survivor = o ?? t!;
      const deletingSideIsSafe = !(tierOf(survivor) > 2);
      if (deletingSideIsSafe) {
        result.set(key, []);
        plan.decisions.push({ subject, predicate, winner: null, loser: survivor.id, rule: 'retract_wins', reason: 'delete vs edit → deletion wins' });
        return;
      }
    }

    // R5 — same tier, at least one side verified: newer wins. Equal timestamps never decide.
    if (o && t && tierOf(o) === tierOf(t) && !opts.strict && tierOf(o) <= 2 && o.tx_from !== t.tx_from) {
      const [w, l] = o.tx_from > t.tx_from ? [o, t] : [t, o];
      result.set(key, [w.id]);
      plan.decisions.push({ subject, predicate, winner: w.id, loser: l.id, rule: 'recency', reason: `same tier T${w.authority}, newer wins` });
      return;
    }

    // R6 — do not guess.
    plan.conflicts.push({
      subject,
      predicate,
      ours: o ?? null,
      theirs: t ?? null,
      base: b ?? null,
      reason: 'no rule applies (same tier, no verifiable evidence)',
    });
    result.set(key, o ? [o.id] : []);
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
  // A merge commit has both tips as parents, so the fold would resurrect anything
  // that still lives on either side. Retract explicitly instead.
  const unionIds = new Set([...oursIds, ...theirsIds]);
  plan.add = [...finalIds].filter((id) => !oursIds.has(id));
  plan.retract = [...unionIds].filter((id) => !finalIds.has(id));
  return plan;
}
