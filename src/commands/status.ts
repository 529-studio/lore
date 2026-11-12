import pc from 'picocolors';
import { openDb, requireRoot } from '../db.js';
import { hashCache } from '../hash-cache.js';
import { gcCandidates } from '../gc.js';
import { activeAt, head } from '../model.js';
import { claimFreshness } from '../merge.js';
import { readConfig } from '../config.js';
import { isAncestor } from '../sync.js';
import { branchFor, currentSession, ensureSession } from '../session.js';

interface CountRow {
  state: string;
  n: number;
}

export interface StatusOptions {
  strict?: boolean;
  maxStale?: string;
  maxConflicts?: string;
  stats?: boolean;
  noCache?: boolean;
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

  const cache = hashCache(db, root);
  if (opts.noCache) cache.enabled = false;

  const stale: Array<{ claim_id: string; ref: string; state: string }> = [];
  const ahead: Array<{ claim_id: string; ref: string }> = [];
  const markStale = db.prepare("UPDATE evidence SET status = 'stale' WHERE claim_id = ? AND ref = ?");
  const markAhead = db.prepare("UPDATE evidence SET status = 'ahead' WHERE claim_id = ? AND ref = ?");
  const markValid = db.prepare("UPDATE evidence SET status = 'valid' WHERE claim_id = ? AND ref = ?");

  const freshness = new Map<string, ReturnType<typeof claimFreshness>>();
  const freshnessOf = (id: string) => {
    if (!freshness.has(id)) freshness.set(id, claimFreshness(db, root, id));
    return freshness.get(id)!;
  };

  for (const ev of evidence) {
    const state = freshnessOf(ev.claim_id);
    if (state === 'stale') {
      stale.push(ev);
      markStale.run(ev.claim_id, ev.ref);
    } else if (state === 'ahead') {
      ahead.push(ev);
      markAhead.run(ev.claim_id, ev.ref);
    } else {
      markValid.run(ev.claim_id, ev.ref);
    }
  }

  const session = ensureSession(db, root);
  const ref = branchFor(session);
  const branchActive = activeAt(db, head(db, ref) ?? head(db, 'main')).size;

  const conflicts = (db.prepare('SELECT COUNT(*) n FROM merge_conflict WHERE resolved = 0').get() as { n: number }).n;
  const gcEligible = gcCandidates(db, { ttlSessions: 3 }).length;

  console.log(pc.bold('lore status'));
  console.log(`  claims     ${pc.bold(String(total))} total  ${pc.green(`${byState.get('active') ?? 0} active`)}  ${pc.yellow(`${byState.get('draft') ?? 0} draft`)}  ${pc.red(`${byState.get('retracted') ?? 0} retracted`)}`);
  console.log(`  branch     ${ref}  ${pc.dim(`${branchActive} claims in the active set`)}`);
  console.log(`  commits    ${commits}   branches ${branches}`);

  const config = readConfig(root);
  if (config?.remote) {
    const local = head(db, 'main');
    const remote = config.remote_main;
    let state = 'not synced yet';
    if (local && remote) {
      if (local === remote) state = 'in sync';
      else if (isAncestor(db, remote, local)) state = 'local ahead';
      else if (isAncestor(db, local, remote)) state = 'behind — run lore fetch';
      else state = 'diverged';
    }
    const label =
      config.remote.type === 'dir'
        ? config.remote.path
        : config.remote.url_env
          ? `postgres ($${config.remote.url_env})`
          : 'postgres';
    console.log(`  remote     ${label} ${pc.dim(`(${state})`)}`);
  }
  console.log(`  stale      ${stale.length ? pc.red(String(stale.length)) : pc.green('0')} ${pc.dim('(evidence hash no longer matches)')}`);
  console.log(`  ahead      ${ahead.length ? pc.yellow(String(ahead.length)) : pc.green('0')} ${pc.dim('(claim observed on newer code than this checkout)')}`);
  console.log(`  conflicts  ${conflicts ? pc.red(String(conflicts)) : pc.green('0')} ${pc.dim('(unresolved merges)')}`);
  console.log(`  gc         ${gcEligible ? pc.yellow(String(gcEligible)) : pc.green('0')} ${pc.dim('drafts unreviewed for 3 sessions — run lore gc')}`);

  if (opts.stats) {
    const c = cache.stats();
    console.log(`  cache      ${c.hits} hits, ${c.reads} reads, ${c.misses} misses${c.enabled ? '' : ' (disabled)'}`);
  }

  if (ahead.length) {
    console.log(pc.dim('\n  ahead of checkout — run `lore fetch` or `lore search --trust-remote`:'));
    for (const a of ahead.slice(0, 5)) console.log(pc.dim(`  • ${a.claim_id}  ${a.ref}`));
    if (ahead.length > 5) console.log(pc.dim(`  … and ${ahead.length - 5} more`));
  }

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
