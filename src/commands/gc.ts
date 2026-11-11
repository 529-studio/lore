import pc from 'picocolors';
import { openDb, requireRoot } from '../db.js';

export interface GcOptions {
  ttlDays?: string;
  dryRun?: boolean;
}

/**
 * SPEC §6: drafts that nobody used are retracted, never deleted.
 * Sessions are not tracked yet, so age (days) is the proxy — documented in SPEC.
 */
export function gcCommand(opts: GcOptions): void {
  const root = requireRoot();
  const db = openDb(root);
  const ttlDays = Number(opts.ttlDays ?? 3);
  const cutoff = new Date(Date.now() - ttlDays * 86_400_000).toISOString();

  const drafts = db
    .prepare("SELECT id, subject_id, predicate, tx_from FROM claim WHERE state = 'draft' AND tx_from < ?")
    .all(cutoff) as Array<{ id: string; subject_id: string; predicate: string; tx_from: string }>;

  if (!drafts.length) {
    console.log(pc.dim(`no drafts older than ${ttlDays} day(s)`));
    db.close();
    return;
  }

  if (opts.dryRun) {
    console.log(`${drafts.length} draft(s) would be retracted (ttl ${ttlDays}d):`);
    for (const d of drafts) console.log(pc.dim(`  ${d.id}  ${d.subject_id} — ${d.predicate}`));
    db.close();
    return;
  }

  const update = db.prepare("UPDATE claim SET state = 'retracted' WHERE id = ?");
  db.transaction(() => {
    for (const d of drafts) update.run(d.id);
  })();

  console.log(`${pc.green('✓')} retracted ${drafts.length} stale draft(s) (ttl ${ttlDays}d, rows kept)`);
  for (const d of drafts.slice(0, 10)) console.log(pc.dim(`  ${d.id}  ${d.subject_id} — ${d.predicate}`));
  if (drafts.length > 10) console.log(pc.dim(`  … và ${drafts.length - 10} claim khác`));
  db.close();
}
