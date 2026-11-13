import type { DB } from '../db.js';
import { claimFreshness } from '../merge.js';
import { inBranch, type ClaimRow, type Trust } from '../model.js';
import { branchFor, currentSession } from '../session.js';

export interface EvidenceExplanation {
  kind: string;
  ref: string;
  hash: string | null;
  commit_id: string | null;
  verified_at: string | null;
  age_days: number | null;
  status: string;
}

export interface ConflictExplanation {
  id: number;
  tier: number;
  resolved: boolean;
  with: string;
  reason: string;
  detected_at: string;
}

export interface ClaimExplanation {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  state: string;
  trust: Trust;
  trust_reason: string;
  in_branch: boolean;
  branch: string;
  author: string;
  written_by: string;
  agent_id: string | null;
  session_id: string | null;
  run_id: string | null;
  tx_from: string;
  valid_from: string | null;
  valid_to: string | null;
  last_verified_at: string | null;
  verified_age_days: number | null;
  confidence: number;
  authority: number;
  confirmations: number;
  contradictions: number;
  evidence: EvidenceExplanation[];
  valid_evidence: number;
  stale_evidence: number;
  supersedes: { id: string; object: string; trust: Trust }[];
  superseded_by: string[];
  conflicts: ConflictExplanation[];
  open_conflicts: number;
  freshness: 'valid' | 'stale' | 'ahead';
}

export interface ExplainResult {
  target: string;
  claims: ClaimExplanation[];
}

const DAY_MS = 86_400_000;
const MAX_CHAIN = 20;

function ageDays(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round((Date.now() - ms) / DAY_MS));
}

function objectOf(claim: ClaimRow): string {
  try {
    return String(JSON.parse(claim.object_json));
  } catch {
    return claim.object_json;
  }
}

/** `c_...` is a claim id; otherwise split the key on its last colon. */
function resolveClaims(db: DB, target: string): ClaimRow[] {
  const byId = db.prepare('SELECT * FROM claim WHERE id = ?').get(target) as ClaimRow | undefined;
  if (byId) return [byId];

  const idx = target.lastIndexOf(':');
  if (idx > 0) {
    const subject = target.slice(0, idx);
    const predicate = target.slice(idx + 1);
    const rows = db
      .prepare('SELECT * FROM claim WHERE subject_id = ? AND predicate = ? ORDER BY tx_from DESC')
      .all(subject, predicate) as ClaimRow[];
    if (rows.length) return rows;
  }

  // Convenience: an entity id shows every predicate it carries.
  return db
    .prepare('SELECT * FROM claim WHERE subject_id = ? ORDER BY predicate, tx_from DESC')
    .all(target) as ClaimRow[];
}

function trustReason(
  claim: ClaimRow,
  conflicts: ConflictExplanation[],
  freshness: 'valid' | 'stale' | 'ahead',
): string {
  const open = conflicts.filter((c) => !c.resolved);
  if (claim.trust === 'retracted' || claim.state === 'retracted') {
    return 'retracted: rejected, redacted or removed by GC';
  }
  if (claim.trust === 'contested') {
    if (!open.length) return 'contested: trust was not restored after the conflict closed';
    return `contested: ${open.length} unresolved tier-1 conflict(s) with ${open.map((c) => c.with).join(', ')}`;
  }
  if (claim.trust === 'candidate') {
    if (claim.state === 'draft') return 'candidate: draft, not yet approved';
    return 'candidate: active but no hashed or commit evidence';
  }
  if (claim.trust === 'stale') {
    let trigger = 'trust marked stale by decay';
    if (claim.invalidated_by_json) {
      try {
        const parsed = JSON.parse(claim.invalidated_by_json) as { trigger?: string; ref?: string };
        trigger = `stale: ${parsed.trigger ?? 'decay'}${parsed.ref ? ` (${parsed.ref})` : ''}`;
      } catch {
        // keep the fallback
      }
    }
    return trigger;
  }

  if (freshness === 'stale') return 'canonical, but evidence hash no longer matches (not injected by default)';
  if (freshness === 'ahead') return 'canonical, but observed on newer code than this checkout (not injected without --trust-remote)';
  return 'canonical: active with hashed or commit evidence';
}

function supersedeChain(db: DB, claim: ClaimRow): {
  previous: Array<{ id: string; object: string; trust: Trust }>;
  next: string[];
} {
  const previous: Array<{ id: string; object: string; trust: Trust }> = [];
  const seen = new Set<string>([claim.id]);
  let cursor = claim.supersedes;
  while (cursor && previous.length < MAX_CHAIN && !seen.has(cursor)) {
    seen.add(cursor);
    const row = db.prepare('SELECT id, object_json, trust FROM claim WHERE id = ?').get(cursor) as
      | { id: string; object_json: string; trust: Trust }
      | undefined;
    if (!row) break;
    previous.push({ id: row.id, object: row.object_json, trust: row.trust });
    const parent = db.prepare('SELECT supersedes FROM claim WHERE id = ?').get(row.id) as
      | { supersedes: string | null }
      | undefined;
    cursor = parent?.supersedes ?? null;
  }

  const next: string[] = [];
  const frontier = [claim.id];
  const visited = new Set<string>([claim.id]);
  while (frontier.length && next.length < MAX_CHAIN) {
    const rows = db
      .prepare(`SELECT id FROM claim WHERE supersedes IN (${frontier.map(() => '?').join(',')}) ORDER BY tx_from`)
      .all(...frontier) as Array<{ id: string }>;
    frontier.length = 0;
    for (const row of rows) {
      if (visited.has(row.id)) continue;
      visited.add(row.id);
      next.push(row.id);
      frontier.push(row.id);
    }
  }
  return { previous, next };
}

function explainClaim(db: DB, root: string, ref: string, claim: ClaimRow): ClaimExplanation {
  const evidence = (
    db
      .prepare(
        `SELECT kind, ref, hash, commit_id, verified_at, status
         FROM evidence WHERE claim_id = ? ORDER BY kind, ref`,
      )
      .all(claim.id) as Array<{
      kind: string;
      ref: string;
      hash: string | null;
      commit_id: string | null;
      verified_at: string | null;
      status: string;
    }>
  ).map((e) => ({ ...e, age_days: ageDays(e.verified_at) }));

  const conflicts = (
    db
      .prepare(
        `SELECT id, tier, left_claim, right_claim, reason, detected_at, resolved
         FROM claim_conflict
         WHERE left_claim = ? OR right_claim = ?
         ORDER BY resolved, detected_at DESC, id DESC`,
      )
      .all(claim.id, claim.id) as Array<{
      id: number;
      tier: number;
      left_claim: string;
      right_claim: string;
      reason: string;
      detected_at: string;
      resolved: number;
    }>
  ).map((c) => ({
    id: c.id,
    tier: c.tier,
    resolved: Boolean(c.resolved),
    with: c.left_claim === claim.id ? c.right_claim : c.left_claim,
    reason: c.reason,
    detected_at: c.detected_at,
  }));

  const chain = supersedeChain(db, claim);
  const freshness = claimFreshness(db, root, claim.id);

  return {
    id: claim.id,
    subject: claim.subject_id,
    predicate: claim.predicate,
    object: objectOf(claim),
    state: claim.state,
    trust: claim.trust,
    trust_reason: trustReason(claim, conflicts, freshness),
    in_branch: inBranch(db, ref, claim.id),
    branch: ref,
    author: claim.author,
    written_by: claim.written_by,
    agent_id: claim.agent_id,
    session_id: claim.session_id,
    run_id: claim.run_id,
    tx_from: claim.tx_from,
    valid_from: claim.valid_from,
    valid_to: claim.valid_to,
    last_verified_at: claim.last_verified_at,
    verified_age_days: ageDays(claim.last_verified_at),
    confidence: claim.confidence,
    authority: claim.authority,
    confirmations: claim.confirmations,
    contradictions: claim.contradictions,
    evidence,
    valid_evidence: evidence.filter((e) => e.status === 'valid').length,
    stale_evidence: evidence.filter((e) => e.status !== 'valid').length,
    supersedes: chain.previous,
    superseded_by: chain.next,
    conflicts,
    open_conflicts: conflicts.filter((c) => !c.resolved).length,
    freshness,
  };
}

/** Explain why a claim is (or is not) in the injected set. */
export function explainTarget(db: DB, root: string, target: string): ExplainResult {
  const resolved = resolveClaims(db, target);
  if (!resolved.length) {
    throw new Error(`no claim matches ${target} (use a claim id, subject:predicate, or an entity id)`);
  }
  const ref = branchFor(currentSession(root));
  return { target, claims: resolved.map((claim) => explainClaim(db, root, ref, claim)) };
}
