import pc from 'picocolors';
import { openDb, requireRoot } from '../db.js';
import { gcCandidates } from '../gc.js';
import { ensureSession } from '../session.js';
import { pruneHashCache } from '../hash-cache.js';

export interface GcOptions {
  ttlSessions?: string;
  ttlDays?: string;
  dryRun?: boolean;
  session?: string;
}

export function gcCommand(opts: GcOptions): void {
  const root = requireRoot();
  const db = openDb(root);
  ensureSession(db, root, opts.session);

  const policy = {
    ttlSessions: Number(opts.ttlSessions ?? 3),
    ...(opts.ttlDays !== undefined ? { ttlDays: Number(opts.ttlDays) } : {}),
  };

  const candidates = gcCandidates(db, policy);

  if (!candidates.length) {
    console.log(pc.dim('no draft claims eligible for GC'));
    db.close();
    return;
  }

  if (opts.dryRun) {
    console.log(`${candidates.length} draft(s) would be retracted:`);
    for (const c of candidates) console.log(pc.dim(`  ${c.id}  ${c.subject} — ${c.predicate}  (${c.reason})`));
    db.close();
    return;
  }

  const update = db.prepare("UPDATE claim SET state = 'retracted', trust = 'retracted' WHERE id = ?");
  db.transaction(() => {
    for (const c of candidates) update.run(c.id);
  })();

  const pruned = pruneHashCache(db);
  console.log(`${pc.green('✓')} retracted ${candidates.length} stale draft(s); rows are kept`);
  if (pruned) console.log(pc.dim(`  pruned ${pruned} hash-cache row(s) older than 30 days`));
  for (const c of candidates.slice(0, 10)) {
    console.log(pc.dim(`  ${c.id}  ${c.subject} — ${c.predicate}  (${c.reason})`));
  }
  if (candidates.length > 10) console.log(pc.dim(`  … and ${candidates.length - 10} more`));
  db.close();
}
