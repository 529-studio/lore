import pc from 'picocolors';
import { openDb, requireRoot } from '../db.js';
import { inBranch, makeCommit, upsertClaim, type ClaimRow } from '../model.js';
import { requireAction } from '../policy.js';
import { branchFor, ensureSession } from '../session.js';
import { gitHead } from '../util/git.js';

export interface AttestOptions {
  claim: string;
  verdict: 'agree' | 'disagree';
  reason?: string;
  session?: string;
}

/**
 * An independent review, stored as a claim with authority T2 and linked to the
 * claim it reviews. Separation of duties: nobody attests their own claim.
 */
export function attestCommand(opts: AttestOptions): void {
  const root = requireRoot();
  const db = openDb(root);
  const session = ensureSession(db, root, opts.session);
  const ref = branchFor(session);

  const claim = db.prepare('SELECT * FROM claim WHERE id = ?').get(opts.claim) as ClaimRow | undefined;
  if (!claim) throw new Error(`no such claim: ${opts.claim}`);

  const principal = requireAction(root, 'attest', { subject: claim.subject_id });
  const actor = `human:${principal.id}`;

  if (claim.author === actor || claim.author === principal.id || claim.author.endsWith(principal.id)) {
    throw new Error('separation of duties: an auditor cannot attest a claim they wrote');
  }

  const object = opts.reason ? `${opts.verdict}: ${opts.reason}` : opts.verdict;

  const apply = db.transaction(() => {
    const result = upsertClaim(db, {
      subject: `claim:${opts.claim}`,
      predicate: 'attested_by',
      object,
      author: actor,
      forceActive: true,
      evidence: [{ kind: 'human', ref: `attest:${principal.id}`, commit: gitHead(root) }],
    });

    db.prepare(
      'INSERT OR REPLACE INTO attestation(claim_id, attestation_claim_id, verdict, actor, ts) VALUES (?, ?, ?, ?, ?)',
    ).run(opts.claim, result.id, opts.verdict, actor, new Date().toISOString());

    if (result.state === 'active' && !inBranch(db, ref, result.id)) {
      makeCommit(db, {
        ref,
        entries: [{ claim_id: result.id, op: 'add' }],
        message: `attest: ${opts.verdict} ${opts.claim}`,
        author: actor,
        kind: 'write',
      });
    }
    return result;
  });

  const result = apply();
  const tone = opts.verdict === 'agree' ? pc.green('agree') : pc.red('disagree');
  console.log(`${pc.green('✓')} ${actor} ${tone} on ${pc.bold(opts.claim)}`);
  console.log(pc.dim(`  attestation claim ${result.id}`));
  if (opts.reason) console.log(pc.dim(`  reason: ${opts.reason}`));
  db.close();
}
