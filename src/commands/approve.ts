import pc from 'picocolors';
import { openDb, requireRoot } from '../db.js';
import { makeCommit } from '../model.js';
import { requireAction } from '../policy.js';
import { branchFor, ensureSession } from '../session.js';

export function approveCommand(opts: { claim?: string; allDrafts?: boolean; session?: string }): void {
  const root = requireRoot();
  const db = openDb(root);
  const session = ensureSession(db, root, opts.session);
  const ref = branchFor(session);

  const targets = (
    opts.allDrafts
      ? db.prepare("SELECT id, authority FROM claim WHERE state = 'draft'").all()
      : opts.claim
        ? db.prepare("SELECT id, authority FROM claim WHERE id = ? AND state = 'draft'").all(opts.claim)
        : []
  ) as Array<{ id: string; authority: number }>;

  if (!targets.length) {
    console.log(pc.yellow('no draft claims to approve'));
    db.close();
    return;
  }

  // The strictest tier decides, so a mixed batch cannot be approved by a contributor.
  const principal = requireAction(root, 'approve', {
    tier: Math.max(...targets.map((t) => t.authority)),
  });

  const apply = db.transaction(() => {
    const update = db.prepare("UPDATE claim SET state = 'active', authority = MIN(authority, 2) WHERE id = ?");
    for (const t of targets) update.run(t.id);
    makeCommit(db, {
      ref,
      entries: targets.map((t) => ({ claim_id: t.id, op: 'add' as const })),
      message: `approve: ${targets.length} draft claim(s)`,
      author: `human:${principal.id}`,
      kind: 'write',
    });
  });
  apply();

  console.log(`${pc.green('✓')} approved ${targets.length} claim(s) as ${principal.id} — now in retrieval on ${ref}`);
  for (const t of targets) console.log(pc.dim(`  ${t.id}`));
  console.log(pc.dim('  other branches see them after: lore promote'));
  db.close();
}
