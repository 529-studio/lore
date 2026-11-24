import pc from 'picocolors';
import { openDb, requireRoot } from '../db.js';
import { attestClaim } from '../actions.js';
import { branchFor, ensureSession } from '../session.js';
import { verifyZkProof, type ZkProof } from '../security/scrub.js';
import type { ClaimRow } from '../model.js';

export interface AttestOptions {
  claim: string;
  verdict?: 'agree' | 'disagree';
  reason?: string;
  session?: string;
  zk?: boolean;
  salt?: string;
  verifyZk?: string;
}

export function attestCommand(opts: AttestOptions): void {
  const root = requireRoot();
  const db = openDb(root);

  if (opts.verifyZk) {
    const claim = db.prepare('SELECT * FROM claim WHERE id = ?').get(opts.claim) as ClaimRow | undefined;
    if (!claim) {
      db.close();
      throw new Error(`claim not found: ${opts.claim}`);
    }
    let proof: ZkProof;
    try {
      proof = JSON.parse(opts.verifyZk) as ZkProof;
    } catch {
      db.close();
      throw new Error(`invalid zero-knowledge proof JSON: ${opts.verifyZk}`);
    }

    let rawObj = claim.object_json;
    try {
      const parsed = JSON.parse(claim.object_json);
      rawObj = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
    } catch {}

    const verification = verifyZkProof({ id: claim.id, object: rawObj }, proof);
    if (!verification.valid) {
      db.close();
      throw new Error(`zero-knowledge verification failed: ${verification.reason}`);
    }

    console.log(`${pc.green('✓')} [OK] zero-knowledge attestation verified for ${pc.bold(opts.claim)}`);
    console.log(pc.dim(`  actor: ${proof.actor} (verdict: ${proof.verdict})`));
    console.log(pc.dim(`  commitment: ${proof.commitment}`));
    db.close();
    return;
  }

  const session = ensureSession(db, root, opts.session);
  const ref = branchFor(session);
  const verdict = opts.verdict ?? 'agree';

  const result = attestClaim(db, root, ref, opts.claim, verdict, opts.reason, {
    zk: opts.zk,
    salt: opts.salt,
  });
  const tone = verdict === 'agree' ? pc.green('agree') : pc.red('disagree');
  console.log(`${pc.green('✓')} human:${result.principal.id} ${tone} on ${pc.bold(opts.claim)}${opts.zk ? ' (zero-knowledge)' : ''}`);
  console.log(pc.dim(`  attestation claim ${result.attestationId}`));
  if (result.proof) {
    console.log(pc.dim(`  zk commitment: ${result.proof.commitment}`));
    console.log(pc.dim(`  zk proof: ${JSON.stringify(result.proof)}`));
  }
  if (opts.reason) console.log(pc.dim(`  reason: ${opts.reason}`));
  db.close();
}
