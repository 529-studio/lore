import pc from 'picocolors';
import { openDb, requireRoot } from '../db.js';
import { approveDrafts } from '../actions.js';
import { branchFor, ensureSession } from '../session.js';

export function approveCommand(opts: { claim?: string; allDrafts?: boolean; session?: string }): void {
  const root = requireRoot();
  const db = openDb(root);
  const session = ensureSession(db, root, opts.session);
  const ref = branchFor(session);

  const ids = opts.claim
    ? [opts.claim]
    : opts.allDrafts
      ? (db.prepare("SELECT id FROM claim WHERE state = 'draft'").all() as Array<{ id: string }>).map((r) => r.id)
      : [];

  const result = approveDrafts(db, root, ref, ids);

  if (!result.changed.length) {
    console.log(pc.yellow('no draft claims to approve'));
    db.close();
    return;
  }

  console.log(
    `${pc.green('✓')} approved ${result.changed.length} claim(s) as ${result.principal.id} — now in retrieval on ${ref}`,
  );
  for (const change of result.changed) console.log(pc.dim(`  ${change.claim_id}`));
  console.log(pc.dim('  other branches see them after: lore promote'));
  db.close();
}
