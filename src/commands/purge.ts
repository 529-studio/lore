import pc from 'picocolors';
import { openDb, requireRoot } from '../db.js';
import { runClaimRetractHooks } from '../model.js';
import { requireAction } from '../policy.js';

export interface PurgeOptions {
  claim: string;
  reason?: string;
  author?: string;
  yes?: boolean;
}

export function purgeCommand(opts: PurgeOptions): void {
  if (!opts.yes) {
    throw new Error('purge removes the row permanently; re-run with --yes to confirm');
  }

  const root = requireRoot();
  const db = openDb(root);

  const claim = db.prepare('SELECT id, subject_id, predicate FROM claim WHERE id = ?').get(opts.claim) as
    | { id: string; subject_id: string; predicate: string }
    | undefined;
  if (!claim) throw new Error(`no such claim: ${opts.claim}`);

  const principal = requireAction(root, 'purge', { subject: claim.subject_id });
  const actor = opts.author ?? `human:${principal.id}`;
  const now = new Date().toISOString();

  const apply = db.transaction(() => {
    runClaimRetractHooks(db, opts.claim, actor);
    db.prepare('DELETE FROM commit_entry WHERE claim_id = ?').run(opts.claim);
    db.prepare('DELETE FROM evidence WHERE claim_id = ?').run(opts.claim);
    db.prepare('UPDATE claim SET supersedes = NULL WHERE supersedes = ?').run(opts.claim);
    db.prepare('DELETE FROM redaction WHERE claim_id = ?').run(opts.claim);
    db.prepare('DELETE FROM claim WHERE id = ?').run(opts.claim);
    db.prepare(
      'INSERT INTO purge_audit(claim_id, actor, reason, ts) VALUES (?, ?, ?, ?) ON CONFLICT(claim_id) DO NOTHING',
    ).run(opts.claim, actor, opts.reason ?? null, now);
  });
  apply();

  console.log(`${pc.green('✓')} purged ${pc.bold(opts.claim)} (${claim.subject_id} — ${claim.predicate})`);
  console.log(pc.dim('  content and evidence removed; the audit row keeps id, actor, reason and time'));
  db.close();
}
