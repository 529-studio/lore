import type { DB } from '../db.js';
import { resolveInside } from '../extract/index.js';
import { hashCache } from '../hash-cache.js';
import { claimFreshness } from '../merge.js';
import type { ClaimRow, Trust } from '../model.js';
import { gitHead, isGitAncestor } from '../util/git.js';

export type DecayTrigger = 'ttl' | 'path-disappeared' | 'file-hash-changed';

export interface DecayResult {
  trigger: DecayTrigger;
  ref: string;
  detail: string;
}

export interface DecayHit {
  id: string;
  subject: string;
  predicate: string;
  trust_before: Trust;
  decay: DecayResult;
}

export interface DecayReport {
  checked: number;
  stale: DecayHit[];
}

const DAY_MS = 86_400_000;

/**
 * Why a live claim stopped being reliable. Returns null when nothing decayed.
 *
 * `checkHash: false` is the read-path check (TTL and disappeared paths only), so
 * `--include-stale` can still show claims whose file changed. The sweep and
 * `explain` use the full check.
 *
 * A commit that is no longer an ancestor stays `ahead-of-checkout`, not stale:
 * an older checkout must not invalidate an observation made on newer code
 * (SPEC §8). That case returns null here.
 */
export function evaluateDecay(
  db: DB,
  root: string,
  claim: ClaimRow,
  opts: { checkHash?: boolean } = {},
): DecayResult | null {
  if (claim.state !== 'active' || claim.trust === 'retracted' || claim.trust === 'stale') return null;

  if (claim.ttl_days != null) {
    const base = Date.parse(claim.last_verified_at ?? claim.tx_from);
    if (Number.isFinite(base) && Date.now() - base > claim.ttl_days * DAY_MS) {
      return {
        trigger: 'ttl',
        ref: `ttl_days=${claim.ttl_days}`,
        detail: `not re-verified within ${claim.ttl_days} day(s)`,
      };
    }
  }

  const evidence = db
    .prepare(`SELECT kind, ref, hash, commit_id FROM evidence WHERE claim_id = ? AND kind IN ('file','test')`)
    .all(claim.id) as Array<{ kind: string; ref: string; hash: string | null; commit_id: string | null }>;

  const headCommit = gitHead(root);
  const aheadOfCheckout = (commitId: string | null): boolean =>
    Boolean(commitId && headCommit && !isGitAncestor(root, commitId, headCommit));

  for (const ev of evidence) {
    if (!resolveInside(root, ev.ref)) {
      // A path missing at an older checkout is ahead-of-checkout, not deleted.
      if (aheadOfCheckout(ev.commit_id)) continue;
      return {
        trigger: 'path-disappeared',
        ref: ev.ref,
        detail: `evidence path no longer exists: ${ev.ref}`,
      };
    }
  }

  if (opts.checkHash === false) return null;
  if (claimFreshness(db, root, claim.id) === 'ahead') return null;

  const cache = hashCache(db, root);
  for (const ev of evidence) {
    if (!ev.hash) continue;
    const current = cache.hash(ev.ref);
    if (current === ev.hash) continue;
    if (aheadOfCheckout(ev.commit_id)) continue;
    return {
      trigger: 'file-hash-changed',
      ref: ev.ref,
      detail: `content changed since observation: ${ev.ref}`,
    };
  }

  return null;
}

/** Persist a decay decision. The row is kept; only trust and the reason change. */
export function markDecay(db: DB, claimId: string, decay: DecayResult): void {
  db.prepare(
    `UPDATE claim SET trust = 'stale', invalidated_by_json = ?
     WHERE id = ? AND state = 'active' AND trust <> 'retracted'`,
  ).run(JSON.stringify({ ...decay, at: new Date().toISOString() }), claimId);
}

/**
 * Nightly sweep (`lore canon decay`). Evaluates every live claim and persists
 * stale. Nothing is deleted.
 */
export function sweepDecay(db: DB, root: string, opts: { dryRun?: boolean } = {}): DecayReport {
  const rows = db
    .prepare(
      `SELECT * FROM claim
       WHERE state = 'active' AND trust IN ('canonical','candidate','contested')`,
    )
    .all() as ClaimRow[];

  const run = db.transaction((): DecayHit[] => {
    const stale: DecayHit[] = [];
    for (const claim of rows) {
      const decay = evaluateDecay(db, root, claim, { checkHash: true });
      if (!decay) continue;
      stale.push({
        id: claim.id,
        subject: claim.subject_id,
        predicate: claim.predicate,
        trust_before: claim.trust,
        decay,
      });
      if (!opts.dryRun) markDecay(db, claim.id, decay);
    }
    return stale;
  });

  return { checked: rows.length, stale: run() };
}

/**
 * Re-verification restores a decayed claim. An open tier-1 conflict keeps it
 * contested; only a clean claim becomes canonical again.
 */
export function restoreAfterReverify(
  db: DB,
  claimId: string,
  opts: { confirm?: boolean } = {},
): Trust | null {
  const claim = db.prepare('SELECT * FROM claim WHERE id = ?').get(claimId) as ClaimRow | undefined;
  if (!claim || claim.state !== 'active' || claim.trust === 'retracted') return null;

  const open = (
    db
      .prepare(
        `SELECT COUNT(*) n FROM claim_conflict
         WHERE resolved = 0 AND (left_claim = ? OR right_claim = ?)`,
      )
      .get(claimId, claimId) as { n: number }
  ).n;
  const trust: Trust = open ? 'contested' : 'canonical';
  db.prepare(
    `UPDATE claim SET trust = ?, last_verified_at = ?, invalidated_by_json = NULL,
                      confirmations = confirmations + ?
     WHERE id = ?`,
  ).run(trust, new Date().toISOString(), opts.confirm ? 1 : 0, claimId);
  return trust;
}
