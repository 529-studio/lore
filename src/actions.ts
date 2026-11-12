import type { DB } from './db.js';
import { activeAt, head, inBranch, makeCommit, upsertClaim, type ClaimRow } from './model.js';
import { requireAction } from './policy.js';
import type { Principal } from './identity.js';
import { resolveRevision } from './revision.js';
import { gitHead } from './util/git.js';
import { createHash } from 'node:crypto';

export type ActionErrorCode = 'not_found' | 'policy' | 'invalid' | 'noop';

export class ActionError extends Error {
  constructor(
    readonly code: ActionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ActionError';
  }
}

export interface ActionResult {
  principal: Principal;
  changed: Array<{ claim_id: string; op: 'add' | 'retract' | 'restore' }>;
  skipped: Array<{ claim_id: string; reason: string }>;
  commitId: string | null;
}

type Op = 'add' | 'supersede' | 'retract' | 'restore';

/**
 * Approve draft claims. The strictest tier in the batch decides the required role,
 * so a contributor cannot approve a mixed batch that contains inference.
 */
export function approveDrafts(db: DB, root: string, ref: string, ids: string[]): ActionResult {
  const rows = (
    ids.length
      ? db.prepare(`SELECT id, authority FROM claim WHERE state = 'draft' AND id IN (${ids.map(() => '?').join(',')})`).all(...ids)
      : []
  ) as Array<{ id: string; authority: number }>;

  if (!rows.length) {
    return { principal: requireAction(root, 'approve', { tier: 4 }), changed: [], skipped: [], commitId: null };
  }

  const principal = requireAction(root, 'approve', { tier: Math.max(...rows.map((r) => r.authority)) });
  let commitId: string | null = null;

  db.transaction(() => {
    const update = db.prepare(
      `UPDATE claim SET state = 'active', authority = MIN(authority, 2),
                        trust = 'canonical', last_verified_at = ? WHERE id = ?`,
    );
    const now = new Date().toISOString();
    for (const row of rows) update.run(now, row.id);
    commitId = makeCommit(db, {
      ref,
      entries: rows.map((row) => ({ claim_id: row.id, op: 'add' as const })),
      message: `approve: ${rows.length} draft claim(s)`,
      author: `human:${principal.id}`,
      kind: 'write',
    });
  })();

  return {
    principal,
    changed: rows.map((row) => ({ claim_id: row.id, op: 'add' as const })),
    skipped: [],
    commitId,
  };
}

/** Reject a draft: retract it, keep the row and the reason in the commit message. */
export function rejectDraft(db: DB, root: string, ref: string, id: string, reason?: string): ActionResult {
  const claim = db.prepare('SELECT * FROM claim WHERE id = ?').get(id) as ClaimRow | undefined;
  if (!claim) throw new ActionError('not_found', `no such claim: ${id}`);
  if (claim.state !== 'draft') throw new ActionError('invalid', `claim ${id} is ${claim.state}, not draft`);

  const principal = requireAction(root, 'approve', { tier: claim.authority });
  let commitId: string | null = null;

  db.transaction(() => {
    db.prepare("UPDATE claim SET state = 'retracted', trust = 'retracted' WHERE id = ?").run(id);
    if (inBranch(db, ref, id)) {
      commitId = makeCommit(db, {
        ref,
        entries: [{ claim_id: id, op: 'retract' }],
        message: `reject: ${id}${reason ? ` (${reason})` : ''}`,
        author: `human:${principal.id}`,
        kind: 'write',
      });
    }
  })();

  return { principal, changed: [{ claim_id: id, op: 'retract' }], skipped: [], commitId };
}

/** Revert a commit with an inverse commit. History is never rewritten. */
export function revertCommit(db: DB, root: string, ref: string, spec: string): ActionResult {
  const principal = requireAction(root, 'revert');
  const target = resolveRevision(db, spec, root);
  if (!target.id) throw new ActionError('not_found', `unknown commit: ${spec}`);

  const targetRow = db
    .prepare('SELECT id, message FROM memory_commit WHERE id = ?')
    .get(target.id) as { id: string; message: string } | undefined;
  if (!targetRow) throw new ActionError('not_found', `unknown commit: ${spec}`);

  const entries = db
    .prepare('SELECT claim_id, op FROM commit_entry WHERE commit_id = ? ORDER BY rowid')
    .all(target.id) as Array<{ claim_id: string; op: Op }>;

  if (!entries.length) throw new ActionError('noop', `commit ${target.id} touched no claims`);

  const current = activeAt(db, head(db, ref) ?? head(db, 'main'));
  const inverse: Array<{ claim_id: string; op: 'add' | 'retract' | 'restore' }> = [];
  const skipped: Array<{ claim_id: string; reason: string }> = [];

  for (const entry of entries) {
    const isActive = current.has(entry.claim_id);
    if (entry.op === 'add' || entry.op === 'restore') {
      if (isActive) inverse.push({ claim_id: entry.claim_id, op: 'retract' });
      else skipped.push({ claim_id: entry.claim_id, reason: 'already absent' });
    } else if (entry.op === 'retract') {
      if (!isActive) inverse.push({ claim_id: entry.claim_id, op: 'restore' });
      else skipped.push({ claim_id: entry.claim_id, reason: 'already active' });
    } else {
      skipped.push({ claim_id: entry.claim_id, reason: `unsupported op ${entry.op}` });
    }
  }

  if (!inverse.length) throw new ActionError('noop', 'every claim changed since that commit');

  const commitId = makeCommit(db, {
    ref,
    entries: inverse,
    message: `revert: ${target.id} (${targetRow.message})`,
    author: `human:${principal.id}`,
    kind: 'revert',
  });

  return { principal, changed: inverse, skipped, commitId };
}

export interface AttestResult {
  principal: Principal;
  attestationId: string;
  commitId: string | null;
}

/** Independent review, stored as a T2 claim linked to the reviewed claim. */
export function attestClaim(
  db: DB,
  root: string,
  ref: string,
  claimId: string,
  verdict: 'agree' | 'disagree',
  reason?: string,
): AttestResult {
  const claim = db.prepare('SELECT * FROM claim WHERE id = ?').get(claimId) as ClaimRow | undefined;
  if (!claim) throw new ActionError('not_found', `no such claim: ${claimId}`);

  const principal = requireAction(root, 'attest', { subject: claim.subject_id });
  const actor = `human:${principal.id}`;

  if (claim.author === actor || claim.author === principal.id || claim.author.endsWith(principal.id)) {
    throw new ActionError('policy', 'separation of duties: an auditor cannot attest a claim they wrote');
  }

  const object = reason ? `${verdict}: ${reason}` : verdict;
  let attestationId = '';
  let commitId: string | null = null;

  db.transaction(() => {
    const result = upsertClaim(db, {
      subject: `claim:${claimId}`,
      predicate: 'attested_by',
      object,
      author: actor,
      forceActive: true,
      evidence: [{ kind: 'human', ref: `attest:${principal.id}`, commit: gitHead(root) }],
    });
    attestationId = result.id;

    db.prepare(
      'INSERT OR REPLACE INTO attestation(claim_id, attestation_claim_id, verdict, actor, ts) VALUES (?, ?, ?, ?, ?)',
    ).run(claimId, result.id, verdict, actor, new Date().toISOString());

    if (result.state === 'active' && !inBranch(db, ref, result.id)) {
      commitId = makeCommit(db, {
        ref,
        entries: [{ claim_id: result.id, op: 'add' }],
        message: `attest: ${verdict} ${claimId}`,
        author: actor,
        kind: 'write',
      });
    }
  })();

  return { principal, attestationId, commitId };
}
