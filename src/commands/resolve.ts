import pc from 'picocolors';
import { openDb, requireRoot } from '../db.js';
import { claimsFor } from '../model.js';

export interface ResolveOptions {
  subject: string;
  predicate: string;
  take: 'ours' | 'theirs' | 'both';
  reason?: string;
}

export function resolveCommand(opts: ResolveOptions): void {
  const root = requireRoot();
  const db = openDb(root);

  const claims = claimsFor(db, opts.subject).filter((c) => c.predicate === opts.predicate);
  if (!claims.length) {
    throw new Error(`no claims for ${opts.subject} — ${opts.predicate}`);
  }

  db.prepare(
    `INSERT INTO resolution(subject_id, predicate, take, reason, ts, applied)
     VALUES (?, ?, ?, ?, ?, 0)
     ON CONFLICT(subject_id, predicate) DO UPDATE SET
       take = excluded.take, reason = excluded.reason, ts = excluded.ts, applied = 0`,
  ).run(opts.subject, opts.predicate, opts.take, opts.reason ?? null, new Date().toISOString());

  console.log(`${pc.green('✓')} recorded: ${opts.subject} ${pc.dim('—')} ${opts.predicate} → ${pc.bold(opts.take)}`);
  if (opts.reason) console.log(pc.dim(`  reason: ${opts.reason}`));
  console.log(pc.dim('  chạy lại `lore merge <branch>` để áp dụng'));
  db.close();
}
