import { createHash } from 'node:crypto';
import pc from 'picocolors';
import { openDb, requireRoot } from '../db.js';
import { inBranch, makeCommit, type ClaimRow } from '../model.js';
import { branchFor, ensureSession } from '../session.js';
import { requireAction } from '../policy.js';

export interface RedactOptions {
  claim: string;
  reason?: string;
  author?: string;
  session?: string;
}

const REDACTED = '"[redacted]"';

export function redactCommand(opts: RedactOptions): void {
  const root = requireRoot();
  const db = openDb(root);
  const session = ensureSession(db, root, opts.session);
  const ref = branchFor(session);

  const claim = db.prepare('SELECT * FROM claim WHERE id = ?').get(opts.claim) as ClaimRow | undefined;
  if (!claim) throw new Error(`no such claim: ${opts.claim}`);

  const existing = db.prepare('SELECT claim_id FROM redaction WHERE claim_id = ?').get(opts.claim);
  if (existing) throw new Error(`claim ${opts.claim} is already redacted`);

  const principal = requireAction(root, 'redact', { subject: claim.subject_id });
  const actor = opts.author ?? `human:${principal.id}`;
  const originalHash = `sha256:${createHash('sha256').update(claim.object_json).digest('hex')}`;
  const now = new Date().toISOString();

  const apply = db.transaction(() => {
    db.prepare("UPDATE claim SET object_json = ?, state = 'retracted' WHERE id = ?").run(REDACTED, opts.claim);
    db.prepare(
      'INSERT INTO redaction(claim_id, original_hash, actor, reason, ts) VALUES (?, ?, ?, ?, ?)',
    ).run(opts.claim, originalHash, actor, opts.reason ?? null, now);

    if (inBranch(db, ref, opts.claim)) {
      makeCommit(db, {
        ref,
        entries: [{ claim_id: opts.claim, op: 'retract' }],
        message: `redact: ${opts.claim}`,
        author: actor,
        kind: 'write',
      });
    }
  });
  apply();

  console.log(`${pc.green('✓')} redacted ${pc.bold(opts.claim)}`);
  console.log(pc.dim(`  subject ${claim.subject_id} — ${claim.predicate}`));
  console.log(pc.dim(`  original hash kept: ${originalHash.slice(0, 20)}…`));
  if (opts.reason) console.log(pc.dim(`  reason: ${opts.reason}`));
  console.log(pc.dim('  the claim stays in blame with a redacted marker; retrieval and export ignore it'));
  db.close();
}
