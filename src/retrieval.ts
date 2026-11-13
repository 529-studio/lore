import type { DB } from './db.js';
import { hashCache } from './hash-cache.js';
import { evidenceFor, activeAtAsOf, head, type ClaimRow } from './model.js';
import { byKey, claimFreshness, isStale } from './merge.js';
import { loadOntology } from './ontology.js';
import { branchFor, currentSession } from './session.js';

export interface SearchOptions {
  query?: string;
  files?: string[]; // paths in scope
  symbols?: string[]; // entity ids in scope
  budgetTokens?: number; // default 2000
  includeStale?: boolean;
  /** Bi-temporal read: what the branch knew, and what was valid, at this instant. */
  asOf?: string;
  /** Include claims observed on newer code than this checkout. */
  trustRemote?: boolean;
}

export interface SearchHit {
  claim: ClaimRow;
  score: number;
  reasons: string[]; // human-readable scoring breakdown
  stale: boolean;
  /** The claim describes newer code than this checkout. */
  ahead: boolean;
}

/** A fact key with at least one open tier-1 conflict in the caller's branch. */
export interface ContestedFact {
  subject: string;
  predicate: string;
  claim_ids: string[];
  open: number;
}

export interface SearchResult {
  hits: SearchHit[];
  contested: ContestedFact[];
}

const BUDGET_DEFAULT = 2000;

// Weights — SPEC §9. Not configurable: keep the contract stable for M4.
const W_ANCHOR = 3.0;
const W_PROXIMITY = 2.0;
const W_AUTHORITY = 1.5;
const W_VERIFIED = 1.0;
const W_SIMILARITY = 0.5;
const W_STALE = -10.0;


/** A verification older than this no longer earns the recency bonus. */
const VERIFIED_WINDOW_DAYS = 14;
const DAY_MS = 86_400_000;

function parseInstant(value: string, label: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${label}: not a valid ISO date: ${value}`);
  return ms;
}

function validAt(claim: ClaimRow, instant: number): boolean {
  const from = claim.valid_from ? Date.parse(claim.valid_from) : Number.NEGATIVE_INFINITY;
  const to = claim.valid_to ? Date.parse(claim.valid_to) : Number.POSITIVE_INFINITY;
  return from <= instant && instant < to;
}

/**
 * All canonical claims of the caller's branch active set (drafts, candidates,
 * contested, stale and retracted excluded; many-values preserved).
 */
function branchSnapshot(
  db: DB,
  root: string,
  asOf?: string,
): { claims: Map<string, ClaimRow>; activeIds: Set<string> } {
  const session = currentSession(root);
  const branch = branchFor(session);
  const headTip = head(db, branch) ?? head(db, 'main');
  const instant = asOf ? parseInstant(asOf, '--as-of') : Date.now();
  const active = activeAtAsOf(db, headTip, instant);
  const ids = [...active.keys()];
  const rows: ClaimRow[] = [];
  const stmt = db.prepare('SELECT * FROM claim WHERE id = ?');
  for (const id of ids) {
    const row = stmt.get(id) as ClaimRow | undefined;
    if (row && row.state === 'active' && row.trust === 'canonical' && validAt(row, instant)) rows.push(row);
  }
  return { claims: byKey(rows, loadOntology(root).cardinality), activeIds: new Set(ids) };
}

/** Entity ids that carry a path as their canonical part (file/doc/test/sym). */
function pathFromEntity(id: string): string | null {
  const m = /^([a-z]+):(.+)$/.exec(id);
  if (!m) return null;
  if (!['file', 'doc', 'test', 'sym'].includes(m[1] ?? '')) return null;
  // sym:src/a.ts#refundOrder → src/a.ts
  return m[2]?.split('#')[0] ?? null;
}

function dirOf(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx === -1 ? '.' : p.slice(0, idx);
}

function normPath(p: string): string {
  return p.replace(/^\.\//, '').replace(/\/+$/, '') || '.';
}

function moduleBase(spec: string): string {
  const tail = spec.replace(/^(?:node:[^/]+|npm:[^/]+)$/, spec).split('/').pop() ?? spec;
  return tail.replace(/\.[cm]?js$/, '').toLowerCase();
}

function pathBase(p: string): string {
  const name = p.split('/').pop() ?? p;
  return name.replace(/\.[cm]?[jt]sx?$/, '').replace(/\.[a-z]+$/, '').toLowerCase();
}

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

interface ScoreParts {
  score: number;
  reasons: string[];
  /** True when the query or scope actually touches this claim. */
  relevant: boolean;
}

interface ScopeContext {
  files: string[];
  dirs: Set<string>;
  symbols: Set<string>;
  importsOf: Map<string, string[]>; // file path -> imported module specs
  queryTokens: Set<string> | null;
}

/**
 * Within 2 hops of a scope file: same directory (1 hop), or a module-name
 * match on `imports_module` claims (2 hops). Module specs in the graph are
 * bare names ('zod'), so matching is by basename.
 */
function closeByImports(subjectPath: string | null, ctx: ScopeContext): string | null {
  if (!subjectPath) return null;
  const base = pathBase(subjectPath);
  const ownImports = ctx.importsOf.get(subjectPath) ?? [];
  for (const scoped of ctx.files) {
    if (ownImports.some((m) => moduleBase(m) === pathBase(scoped))) {
      return `${subjectPath} ↔ ${scoped}`;
    }
    if ((ctx.importsOf.get(scoped) ?? []).some((m) => moduleBase(m) === base)) {
      return `${subjectPath} ← ${scoped}`;
    }
  }
  return null;
}

function sameDirPrefix(paths: string[], ctx: ScopeContext): string | null {
  for (const p of paths) {
    const d = dirOf(p);
    if (ctx.dirs.has(d)) return p;
    for (const scopeDir of ctx.dirs) {
      if (scopeDir !== '.' && d.startsWith(`${scopeDir}/`)) return p;
    }
  }
  return null;
}

function scoreClaim(
  claim: ClaimRow,
  evidence: Array<{ kind: string; ref: string; verified_at: string | null }>,
  subjectPath: string | null,
  ctx: ScopeContext,
  stale: boolean,
): ScoreParts {
  const parts: number[] = [];
  const reasons: string[] = [];
  let relevant = false;

  // --- anchor: evidence ref or subject path inside the task scope -------------
  const anchorRefs: string[] = [];
  const subjectHit = subjectPath ? ctx.files.includes(subjectPath) : false;
  if (subjectHit) anchorRefs.push(`subject path ${subjectPath}`);
  if (
    ctx.symbols.has(claim.subject_id) ||
    [...ctx.symbols].some((symbol) => claim.subject_id.startsWith(`${symbol}#`))
  ) {
    anchorRefs.push(`subject ${claim.subject_id} in symbols scope`);
  }
  for (const ev of evidence) {
    if (ctx.files.includes(ev.ref)) anchorRefs.push(`evidence ${ev.ref}`);
  }
  if (anchorRefs.length) {
    relevant = true;
    parts.push(W_ANCHOR);
    reasons.push(`+${W_ANCHOR.toFixed(1)} anchor (${anchorRefs.join(', ')})`);
  }

  // --- proximity: same directory prefix or a 2-hop import link ---------------
  const proxPaths = [subjectPath, ...evidence.map((e) => e.ref)].filter(
    (p): p is string => Boolean(p),
  );
  const byPrefix = sameDirPrefix(proxPaths, ctx);
  if (byPrefix) {
    relevant = true;
    parts.push(W_PROXIMITY);
    reasons.push(`+${W_PROXIMITY.toFixed(1)} proximity (same directory prefix as scope: ${dirOf(byPrefix)})`);
  } else {
    const link = closeByImports(subjectPath, ctx);
    if (link) {
      relevant = true;
      parts.push(W_PROXIMITY);
      reasons.push(`+${W_PROXIMITY.toFixed(1)} proximity (imports_module: ${link})`);
    }
  }

  // --- authority: (4 - tier) / 4, low tier wins -------------------------------
  const authorityPart = W_AUTHORITY * ((4 - claim.authority) / 4);
  if (authorityPart > 0) {
    parts.push(authorityPart);
    reasons.push(`+${authorityPart.toFixed(1)} authority (T${claim.authority})`);
  }

  // --- verification recency: fresher verification scores higher --------------
  const times = evidence.map((e) => e.verified_at).filter((v): v is string => Boolean(v));
  if (times.length) {
    const newest = Math.max(...times.map((t) => Date.parse(t)).filter(Number.isFinite));
    if (Number.isFinite(newest)) {
      const days = Math.max(0, (Date.now() - newest) / DAY_MS);
      const part = W_VERIFIED * Math.max(0, 1 - days / VERIFIED_WINDOW_DAYS);
      if (part > 0) {
        parts.push(part);
        reasons.push(`+${part.toFixed(1)} verified (${Math.round(days)}d ago)`);
      }
    }
  }

  // --- text similarity: plain token overlap, no embeddings -------------------
  if (ctx.queryTokens) {
    let objectText = claim.object_json;
    try {
      objectText = String(JSON.parse(claim.object_json));
    } catch {
      // keep raw json
    }
    const claimTokens = tokenize(`${claim.subject_id} ${claim.predicate} ${objectText}`);
    const sim = jaccard(ctx.queryTokens, claimTokens);
    if (sim > 0) {
      relevant = true;
      const part = W_SIMILARITY * sim;
      parts.push(part);
      reasons.push(`+${part.toFixed(1)} text (token overlap ${sim.toFixed(2)})`);
    }
  }

  if (stale) {
    parts.push(W_STALE);
    reasons.push(`${W_STALE.toFixed(1)} stale (evidence hash no longer matches)`);
  }

  return { score: parts.reduce((sum, v) => sum + v, 0), reasons, relevant };
}

/** Approximate context cost of a hit, in tokens (chars/4 — SPEC §9 budget). */
function approxTokens(hit: SearchHit): number {
  const c = hit.claim;
  let objectText = c.object_json;
  try {
    objectText = String(JSON.parse(c.object_json));
  } catch {
    // keep raw json
  }
  const text = `${c.subject_id} ${c.predicate} ${objectText} ${hit.reasons.join(' ')} ${hit.stale ? 'stale' : ''}`;
  return Math.ceil(text.length / 4);
}

/**
 * Contested fact keys still live in this branch. A pair only warns while both
 * sides remain active and contested; a retracted side stops the warning.
 */
function contestedFacts(db: DB, ctx: ScopeContext, activeIds: Set<string>): ContestedFact[] {
  const rows = db
    .prepare(
      `SELECT id, subject_id, predicate, left_claim, right_claim
       FROM claim_conflict
       WHERE resolved = 0
       ORDER BY subject_id, predicate, id`,
    )
    .all() as Array<{
    id: number;
    subject_id: string;
    predicate: string;
    left_claim: string;
    right_claim: string;
  }>;
  if (!rows.length) return [];

  const claimStmt = db.prepare('SELECT id, object_json, state, trust FROM claim WHERE id = ?');
  const evidenceStmt = db.prepare('SELECT ref FROM evidence WHERE claim_id = ?');
  const facts = new Map<string, ContestedFact>();
  const scoped = Boolean(ctx.queryTokens || ctx.files.length || ctx.symbols.size);

  for (const row of rows) {
    if (!activeIds.has(row.left_claim) && !activeIds.has(row.right_claim)) continue;
    const left = claimStmt.get(row.left_claim) as
      | { id: string; object_json: string; state: string; trust: string }
      | undefined;
    const right = claimStmt.get(row.right_claim) as
      | { id: string; object_json: string; state: string; trust: string }
      | undefined;
    if (!left || !right) continue;
    if (left.state !== 'active' || left.trust !== 'contested') continue;
    if (right.state !== 'active' || right.trust !== 'contested') continue;

    if (scoped) {
      const tokens = tokenize(`${row.subject_id} ${row.predicate} ${left.object_json} ${right.object_json}`);
      const queryHit = ctx.queryTokens ? [...ctx.queryTokens].some((t) => tokens.has(t)) : false;
      const subjectPath = pathFromEntity(row.subject_id);
      const pathHit = Boolean(subjectPath && ctx.files.includes(subjectPath));
      const symbolHit =
        ctx.symbols.has(row.subject_id) ||
        [...ctx.symbols].some((symbol) => row.subject_id.startsWith(`${symbol}#`));
      const evidenceHit = [left.id, right.id].some((id) =>
        (evidenceStmt.all(id) as Array<{ ref: string }>).some((e) => ctx.files.includes(e.ref)),
      );
      if (!queryHit && !pathHit && !symbolHit && !evidenceHit) continue;
    }

    const key = `${row.subject_id}\u0000${row.predicate}`;
    const fact = facts.get(key);
    if (fact) {
      fact.open += 1;
      for (const id of [left.id, right.id]) {
        if (!fact.claim_ids.includes(id)) fact.claim_ids.push(id);
      }
    } else {
      facts.set(key, {
        subject: row.subject_id,
        predicate: row.predicate,
        claim_ids: [left.id, right.id],
        open: 1,
      });
    }
  }

  return [...facts.values()].sort((a, b) =>
    `${a.subject}\u0000${a.predicate}`.localeCompare(`${b.subject}\u0000${b.predicate}`),
  );
}

/** The one warning line every reader prints for a contested fact. */
export function contestedWarning(fact: ContestedFact): string {
  return `memory contested: ${fact.subject}:${fact.predicate} — see lore explain`;
}

/**
 * Score the nearest memory for a task, and report contested facts that were
 * withheld. Injection requires `active AND canonical`; candidates, contested
 * claims, stale trust and retracted claims never enter the returned hits.
 */
export function searchMemory(db: DB, root: string, opts: SearchOptions = {}): SearchResult {
  const budget = opts.budgetTokens ?? BUDGET_DEFAULT;
  const { claims: current, activeIds } = branchSnapshot(db, root, opts.asOf);

  // Aliases let a human say "refund flow" and reach doc:...#refund-flow.
  const aliasTargets = new Set<string>();
  if (opts.query) {
    const needle = opts.query.toLowerCase();
    const rows = db.prepare('SELECT alias, entity_id FROM alias').all() as Array<{
      alias: string;
      entity_id: string;
    }>;
    for (const row of rows) if (needle.includes(row.alias.toLowerCase())) aliasTargets.add(row.entity_id);
  }

  const ctx: ScopeContext = {
    files: (opts.files ?? []).map(normPath).filter(Boolean),
    dirs: new Set((opts.files ?? []).map(normPath).filter((p) => p !== '.').map(dirOf)),
    symbols: new Set([...(opts.symbols ?? []), ...aliasTargets]),
    importsOf: new Map(),
    queryTokens: opts.query ? tokenize(opts.query) : null,
  };

  for (const c of current.values()) {
    if (c.predicate !== 'imports_module') continue;
    let mod: string = c.object_json;
    try {
      mod = String(JSON.parse(c.object_json));
    } catch {
      // keep raw
    }
    const from = pathFromEntity(c.subject_id);
    if (!from) continue;
    const list = ctx.importsOf.get(from) ?? [];
    list.push(mod);
    ctx.importsOf.set(from, list);
  }

  const hashlessEvidence = new Map<string, Array<{ kind: string; ref: string; verified_at: string | null }>>();
  for (const c of current.values()) {
    hashlessEvidence.set(c.id, evidenceFor(db, c.id));
  }

  let hits: SearchHit[] = [];
  for (const c of current.values()) {
    const freshness = claimFreshness(db, root, c.id);
    const stale = freshness === 'stale';
    const ahead = freshness === 'ahead';
    if (stale && !opts.includeStale) continue;
    if (ahead && !opts.trustRemote) continue;
    const evidence = hashlessEvidence.get(c.id) ?? [];
    const subjectPath = pathFromEntity(c.subject_id);
    const { score, reasons, relevant } = scoreClaim(c, evidence, subjectPath, ctx, stale);
    // A query must touch the claim: authority and freshness alone are not relevance.
    if (ctx.queryTokens && !relevant) continue;
    hits.push({ claim: c, score, reasons, stale, ahead });
  }

  hits.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const key = (h: SearchHit) => `${h.claim.subject_id}\u0000${h.claim.predicate}`;
    return key(a).localeCompare(key(b));
  });

  const out: SearchHit[] = [];
  let used = 0;
  for (const hit of hits) {
    const cost = approxTokens(hit);
    if (used + cost > budget) break;
    out.push(hit);
    used += cost;
  }

  return { hits: out, contested: contestedFacts(db, ctx, activeIds) };
}

/** Hits only, for callers that do not surface contested warnings. */
export function searchClaims(db: DB, root: string, opts: SearchOptions = {}): SearchHit[] {
  return searchMemory(db, root, opts).hits;
}

export interface VerifyResult {
  ok: boolean;
  checked: number;
  stale: string[];
}

/**
 * Rehash the file/test evidence of one claim and record the result as
 * evidence.status ('valid' | 'stale'). The stored hash is intentionally NOT
 * rewritten — stale only clears when the backing file/test matches what was
 * observed, or after re-ingesting with a fresh observation.
 */
export function verifyClaim(
  db: DB,
  root: string,
  claimId: string,
  opts: { accept?: boolean } = {},
): VerifyResult {
  const rows = db
    .prepare(
      `SELECT kind, ref, hash FROM evidence
       WHERE claim_id = ? AND kind IN ('file','test') AND hash IS NOT NULL`,
    )
    .all(claimId) as Array<{ kind: string; ref: string; hash: string }>;

  const stale: string[] = [];
  let checked = 0;
  const now = new Date().toISOString();
  const markValid = db.prepare(
    "UPDATE evidence SET status = 'valid', verified_at = ? WHERE claim_id = ? AND kind = ? AND ref = ?",
  );
  const markStale = db.prepare(
    "UPDATE evidence SET status = 'stale' WHERE claim_id = ? AND kind = ? AND ref = ?",
  );
  const acceptNewHash = db.prepare(
    "UPDATE evidence SET hash = ?, status = 'valid', verified_at = ? WHERE claim_id = ? AND kind = ? AND ref = ?",
  );
  for (const row of rows) {
    checked++;
    const current = hashCache(db, root).hash(row.ref);
    if (current === row.hash) {
      markValid.run(now, claimId, row.kind, row.ref);
    } else if (opts.accept && current) {
      // Re-observation: the file changed for a reason the human accepts.
      acceptNewHash.run(current, now, claimId, row.kind, row.ref);
    } else {
      stale.push(row.ref);
      markStale.run(claimId, row.kind, row.ref);
    }
  }
  return { ok: stale.length === 0, checked, stale };
}
