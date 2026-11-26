import pc from 'picocolors';
import { openDb, requireRoot, type DB } from '../db.js';
import { hashCache } from '../hash-cache.js';
import { gcCandidates, tombstoneCandidates, getDatabaseStorageStats } from '../gc.js';
import { activeAt, head } from '../model.js';
import { claimFreshness } from '../merge.js';
import { readConfig, remoteLabel } from '../config.js';
import { isAncestor } from '../sync.js';
import { isPermissiveTrust } from '../policy.js';
import { branchFor, currentSession, ensureSession } from '../session.js';
import { canonStatus } from '../canon/status.js';

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
  json?: boolean;
}

/** Commit ids reachable from a tip, following both parents of a merge. */
function ancestry(db: DB, tip: string): Set<string> {
  const seen = new Set<string>();
  const queue = [tip];
  const stmt = db.prepare('SELECT parent_id, merge_parent_id FROM memory_commit WHERE id = ?');
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const row = stmt.get(id) as { parent_id: string | null; merge_parent_id: string | null } | undefined;
    if (row?.parent_id) queue.push(row.parent_id);
    if (row?.merge_parent_id) queue.push(row.merge_parent_id);
  }
  return seen;
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
  const branchIds = activeAt(db, head(db, ref) ?? head(db, 'main'));

  // Live drift is computed from evidence hashes, above. Count claims, not
  // evidence rows, so one claim with several drifted files counts once.
  const staleClaimIds = new Set(stale.map((s) => s.claim_id));
  let branchStale = 0;
  let branchContested = 0;
  if (branchIds.size) {
    const claimStmt = db.prepare('SELECT trust FROM claim WHERE id = ?');
    for (const id of branchIds.keys()) {
      const row = claimStmt.get(id) as { trust: string } | undefined;
      if (!row) continue;
      if (row.trust === 'stale' || staleClaimIds.has(id)) branchStale += 1;
      if (row.trust === 'contested') branchContested += 1;
    }
  }

  const conflicts = (db.prepare('SELECT COUNT(*) n FROM merge_conflict WHERE resolved = 0').get() as { n: number }).n;
  const canon = canonStatus(db);
  const gcEligible = gcCandidates(db, { ttlSessions: 3 }).length;
  const tombstonesEligible = tombstoneCandidates(db, { tombstoneTtlDays: 30 }).length;
  const storage = getDatabaseStorageStats(db);
  const permissive = isPermissiveTrust(root);

  const config = readConfig(root);
  const localMain = head(db, 'main');
  const remoteMain = config?.remote_main ?? null;
  let remoteState = 'not synced yet';
  if (localMain && remoteMain) {
    if (localMain === remoteMain) remoteState = 'in sync';
    else if (isAncestor(db, remoteMain, localMain)) remoteState = 'local ahead';
    else if (isAncestor(db, localMain, remoteMain)) remoteState = 'behind';
    else remoteState = 'diverged';
  }
  const staleRefs = new Map<string, string[]>();
  for (const row of stale) {
    const refs = staleRefs.get(row.claim_id) ?? [];
    refs.push(row.ref);
    staleRefs.set(row.claim_id, refs);
  }
  const aheadRefs = new Map<string, string[]>();
  for (const row of ahead) {
    const refs = aheadRefs.get(row.claim_id) ?? [];
    refs.push(row.ref);
    aheadRefs.set(row.claim_id, refs);
  }
  const claimDetails = (ids: Iterable<string>, refs: Map<string, string[]>) => {
    const stmt = db.prepare('SELECT id, subject_id, predicate, author FROM claim WHERE id = ?');
    const out: Array<{ id: string; subject: string; predicate: string; author: string; evidence: string[] }> = [];
    for (const id of ids) {
      const row = stmt.get(id) as
        | { id: string; subject_id: string; predicate: string; author: string }
        | undefined;
      if (row) {
        out.push({
          id: row.id,
          subject: row.subject_id,
          predicate: row.predicate,
          author: row.author,
          evidence: refs.get(id) ?? [],
        });
      }
    }
    return out;
  };

  if (opts.json) {
    const localAncestry = localMain ? ancestry(db, localMain) : new Set<string>();
    const report = {
      branch: ref,
      session,
      claims: {
        total,
        active: byState.get('active') ?? 0,
        draft: byState.get('draft') ?? 0,
        retracted: byState.get('retracted') ?? 0,
      },
      trust: canon.trust,
      active_set: branchIds.size,
      branch_stale: branchStale,
      stale: staleClaimIds.size,
      stale_claims: claimDetails(staleClaimIds, staleRefs),
      ahead: ahead.length,
      ahead_claims: claimDetails(new Set(ahead.map((a) => a.claim_id)), aheadRefs),
      conflicts,
      tier1_conflicts: canon.unresolved_conflicts,
      gc_eligible: gcEligible,
      tombstones_eligible: tombstonesEligible,
      trust_mode: permissive ? 'permissive' : 'strict',
      remote: config?.remote
        ? {
            type: config.remote.type,
            label: remoteLabel(config.remote),
            state: remoteState,
            local_main: localMain,
            remote_main: remoteMain,
            behind:
              localMain && remoteMain && isAncestor(db, localMain, remoteMain)
                ? [...ancestry(db, remoteMain)].filter((id) => !localAncestry.has(id)).length
                : 0,
          }
        : null,
    };
    console.log(JSON.stringify(report, null, 2));
    db.close();
    return;
  }

  console.log(pc.bold('lore status'));
  console.log(`  claims     ${pc.bold(String(total))} total  ${pc.green(`${byState.get('active') ?? 0} active`)}  ${pc.yellow(`${byState.get('draft') ?? 0} draft`)}  ${pc.red(`${byState.get('retracted') ?? 0} retracted`)}  ${pc.dim('(store-wide)')}`);
  console.log(
    `  trust      ${pc.green(`${canon.trust.canonical} canonical`)}  ${pc.yellow(`${canon.trust.candidate} candidate`)}  ` +
      `${canon.trust.contested ? pc.red(`${canon.trust.contested} contested`) : pc.dim('0 contested')}  ` +
      `${canon.trust.retracted ? pc.red(`${canon.trust.retracted} retracted`) : pc.dim('0 retracted')}  ` +
      `${pc.dim('(persisted canon state, store-wide)')}`,
  );
  console.log(
    `  branch     ${ref}  ${pc.dim(`${branchIds.size} in active set`)}  ` +
      `${branchStale ? pc.red(`${branchStale} stale`) : pc.dim('0 stale')}  ` +
      `${branchContested ? pc.red(`${branchContested} contested`) : pc.dim('0 contested')}  ` +
      `${pc.dim(`(this branch, live) [mode: ${permissive ? 'permissive' : 'strict'}]`)}`,
  );
  console.log(`  commits    ${commits}   branches ${branches}`);

  if (config?.remote) {
    const label = remoteLabel(config.remote);
    console.log(
      `  remote     ${label} ${pc.dim(`(${remoteState === 'behind' ? 'behind — run lore fetch' : remoteState})`)}`,
    );
  }
  console.log(
    `  stale      ${staleClaimIds.size ? pc.red(String(staleClaimIds.size)) : pc.green('0')} ` +
      `${pc.dim('(evidence hash no longer matches; live drift, store-wide)')}`,
  );
  console.log(`  ahead      ${ahead.length ? pc.yellow(String(ahead.length)) : pc.green('0')} ${pc.dim('(claim observed on newer code than this checkout)')}`);
  console.log(`  conflicts  ${conflicts ? pc.red(String(conflicts)) : pc.green('0')} ${pc.dim('(unresolved merges)')}  ${canon.unresolved_conflicts ? pc.red(String(canon.unresolved_conflicts)) : pc.green('0')} ${pc.dim('(tier-1 facts)')}`);
  const gcParts = [
    `${gcEligible ? pc.yellow(String(gcEligible)) : pc.green('0')} ${pc.dim('drafts unreviewed for 3 sessions — run lore gc')}`,
  ];
  if (tombstonesEligible > 0) {
    gcParts.push(`${pc.yellow(String(tombstonesEligible))} ${pc.dim('purgeable tombstones (>=30d)')}`);
  }
  if (storage.freelistPages > 0) {
    gcParts.push(pc.dim(`${storage.freelistPages} freelist pages`));
  }
  console.log(`  gc         ${gcParts.join('  ')}`);

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
    const stalePct = total > 0 ? (staleClaimIds.size / total) * 100 : 0;
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
