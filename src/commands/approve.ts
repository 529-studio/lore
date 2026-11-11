import pc from 'picocolors';
import { openDb, requireRoot } from '../db.js';
import { makeCommit } from '../model.js';
import { branchFor, currentSession } from '../session.js';

export function approveCommand(opts: { claim?: string; allDrafts?: boolean; session?: string }): void {
  const root = requireRoot();
  const db = openDb(root);
  const session = currentSession(root, opts.session);
  const ref = branchFor(session);

  const apply = db.transaction(() => {
    const targets = opts.allDrafts
      ? (db.prepare("SELECT id FROM claim WHERE state = 'draft'").all() as Array<{ id: string }>)
      : opts.claim
        ? (db.prepare("SELECT id FROM claim WHERE id = ? AND state = 'draft'").all(opts.claim) as Array<{ id: string }>)
        : [];

    if (!targets.length) return [];

    const update = db.prepare("UPDATE claim SET state = 'active', authority = MIN(authority, 2) WHERE id = ?");
    for (const t of targets) update.run(t.id);

    makeCommit(db, {
      ref,
      entries: targets.map((t) => ({ claim_id: t.id, op: 'add' as const })),
      message: `approve: ${targets.length} draft claim(s)`,
      author: 'human:cli',
      kind: 'write',
    });
    return targets;
  });

  const targets = apply();

  if (!targets.length) {
    console.log(pc.yellow('no draft claims to approve'));
    db.close();
    return;
  }

  console.log(`${pc.green('✓')} approved ${targets.length} claim(s) — they now enter retrieval on branch ${ref}`);
  for (const t of targets) console.log(pc.dim(`  ${t.id}`));
  console.log(pc.dim('  other branches see them after: lore promote'));
  db.close();
}
