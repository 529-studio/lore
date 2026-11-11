import pc from 'picocolors';
import { openDb, requireRoot } from '../db.js';
import { hashFile } from '../extract/index.js';
import { activeAt, head } from '../model.js';
import { branchFor, currentSession } from '../session.js';

interface CountRow {
  state: string;
  n: number;
}

export interface StatusOptions {
  strict?: boolean;
  maxStale?: string;
  maxConflicts?: string;
}

export function statusCommand(opts: StatusOptions = {}): void {
  const root = requireRoot();
  const db = openDb(root);

  const counts = db.prepare('SELECT state, COUNT(*) n FROM claim GROUP BY state').all() as CountRow[];
  const total = counts.reduce((sum, r) => sum + r.n, 0);
  const byState = new Map(counts.map((r) => [r.state, r.n]));

  const commits = (db.prepare('SELECT COUNT(*) n FROM memory_commit').get() as { n: number }).n;
  const branches = (db.prepare('SELECT COUNT(*) n FROM ref').get() as { n: number }).n;

  const evidence = db
    .prepare(
      `SELECT e.claim_id, e.ref, e.hash, c.state
       FROM evidence e JOIN claim c ON c.id = e.claim_id
       WHERE e.kind IN ('file','test') AND e.hash IS NOT NULL`,
    )
    .all() as Array<{ claim_id: string; ref: string; hash: string; state: string }>;

  const stale: Array<{ claim_id: string; ref: string; state: string }> = [];
  const markStale = db.prepare("UPDATE evidence SET status = 'stale' WHERE claim_id = ? AND ref = ?");
  const markValid = db.prepare("UPDATE evidence SET status = 'valid' WHERE claim_id = ? AND ref = ?");
  for (const ev of evidence) {
    const current = hashFile(root, ev.ref);
    if (current !== ev.hash) {
      stale.push(ev);
      markStale.run(ev.claim_id, ev.ref);
    } else {
      markValid.run(ev.claim_id, ev.ref);
    }
  }

  const session = currentSession(root);
  const ref = branchFor(session);
  const branchActive = activeAt(db, head(db, ref) ?? head(db, 'main')).size;

  const conflicts = (db.prepare('SELECT COUNT(*) n FROM merge_conflict WHERE resolved = 0').get() as { n: number }).n;
  const gcCutoff = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const gcEligible = (
    db.prepare("SELECT COUNT(*) n FROM claim WHERE state = 'draft' AND tx_from < ?").get(gcCutoff) as { n: number }
  ).n;

  console.log(pc.bold('lore status'));
  console.log(`  claims     ${pc.bold(String(total))} total  ${pc.green(`${byState.get('active') ?? 0} active`)}  ${pc.yellow(`${byState.get('draft') ?? 0} draft`)}  ${pc.red(`${byState.get('retracted') ?? 0} retracted`)}`);
  console.log(`  branch     ${ref}  ${pc.dim(`${branchActive} claims in the active set`)}`);
  console.log(`  commits    ${commits}   branches ${branches}`);
  console.log(`  stale      ${stale.length ? pc.red(String(stale.length)) : pc.green('0')} ${pc.dim('(evidence hash no longer matches)')}`);
  console.log(`  conflicts  ${conflicts ? pc.red(String(conflicts)) : pc.green('0')} ${pc.dim('(unresolved merges)')}`);
  console.log(`  gc         ${gcEligible ? pc.yellow(String(gcEligible)) : pc.green('0')} ${pc.dim('drafts older than 3 days — run lore gc')}`);

  if (stale.length) {
    console.log(pc.dim('\n  stale claims — kept, waiting to be verified:'));
    for (const s of stale.slice(0, 8)) {
      console.log(pc.dim(`  • ${s.claim_id}  ${s.ref}`));
    }
    if (stale.length > 8) console.log(pc.dim(`  … and ${stale.length - 8} more claim(s)`));
    console.log(pc.dim('  run `lore ingest` to re-observe changed files'));
  }

  if (opts.strict) {
    const maxStale = Number(opts.maxStale ?? 15);
    const maxConflicts = Number(opts.maxConflicts ?? 0);
    const stalePct = total > 0 ? (stale.length / total) * 100 : 0;
    const reasons: string[] = [];
    if (stalePct > maxStale) {
      reasons.push(`stale ${stalePct.toFixed(1)}% > ${maxStale}%`);
    }
    if (conflicts > maxConflicts) {
      reasons.push(`conflicts ${conflicts} > ${maxConflicts}`);
    }
    if (reasons.length) {
      console.error(`[ERR] memory health: ${reasons.join(', ')}`);
      process.exitCode = 3;
    }
  }

  db.close();
}
