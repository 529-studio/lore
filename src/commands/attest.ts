import pc from 'picocolors';
import { openDb, requireRoot } from '../db.js';
import { attestClaim } from '../actions.js';
import { branchFor, ensureSession } from '../session.js';

export interface AttestOptions {
  claim: string;
  verdict: 'agree' | 'disagree';
  reason?: string;
  session?: string;
}

export function attestCommand(opts: AttestOptions): void {
  const root = requireRoot();
  const db = openDb(root);
  const session = ensureSession(db, root, opts.session);
  const ref = branchFor(session);

  const result = attestClaim(db, root, ref, opts.claim, opts.verdict, opts.reason);
  const tone = opts.verdict === 'agree' ? pc.green('agree') : pc.red('disagree');
  console.log(`${pc.green('✓')} human:${result.principal.id} ${tone} on ${pc.bold(opts.claim)}`);
  console.log(pc.dim(`  attestation claim ${result.attestationId}`));
  if (opts.reason) console.log(pc.dim(`  reason: ${opts.reason}`));
  db.close();
}
