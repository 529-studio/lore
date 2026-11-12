import pc from 'picocolors';
import { openDb, requireRoot } from '../db.js';
import { rejectDraft } from '../actions.js';
import { branchFor, ensureSession } from '../session.js';

export interface RejectOptions {
  claim: string;
  reason?: string;
  session?: string;
}

export function rejectCommand(opts: RejectOptions): void {
  const root = requireRoot();
  const db = openDb(root);
  const session = ensureSession(db, root, opts.session);
  const ref = branchFor(session);

  const result = rejectDraft(db, root, ref, opts.claim, opts.reason);
  console.log(`${pc.green('✓')} rejected ${pc.bold(opts.claim)} as ${result.principal.id}`);
  if (opts.reason) console.log(pc.dim(`  reason: ${opts.reason}`));
  console.log(pc.dim('  the row stays; the draft is retracted and will not enter retrieval'));
  db.close();
}
