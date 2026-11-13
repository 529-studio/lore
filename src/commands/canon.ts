import pc from 'picocolors';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { openDb, requireRoot } from '../db.js';
import { canonStatus, TRUST_ORDER } from '../canon/status.js';
import { restoreAfterReverify, sweepDecay } from '../canon/decay.js';
import { canonMetrics } from '../canon/metrics.js';
import { requireAction } from '../policy.js';
import { gitHead } from '../util/git.js';

export interface CanonStatusOptions {
  json?: boolean;
}

export interface CanonDecayOptions {
  dryRun?: boolean;
  json?: boolean;
}

export interface CanonConfirmOptions {
  json?: boolean;
}

export interface CanonMetricsOptions {
  json?: boolean;
  out?: string;
}

/** lore canon status — trust counts and unresolved tier-1 conflicts. */
export function canonStatusCommand(opts: CanonStatusOptions = {}): void {
  const root = requireRoot();
  const db = openDb(root);
  const status = canonStatus(db);
  db.close();

  if (opts.json) {
    console.log(JSON.stringify({ schema: 1, ...status }, null, 2));
    return;
  }

  console.log(pc.bold('lore canon status'));
  for (const trust of TRUST_ORDER) {
    const color =
      trust === 'canonical'
        ? pc.green
        : trust === 'contested' || trust === 'stale'
          ? pc.red
          : pc.yellow;
    console.log(`  ${trust.padEnd(10)} ${color(String(status.trust[trust]).padStart(4))}`);
  }
  console.log(`  ${pc.dim('total'.padEnd(10))} ${String(status.total).padStart(4)}`);
  console.log(
    `  ${pc.dim('conflicts')}  ${status.unresolved_conflicts ? pc.red(String(status.unresolved_conflicts)) : pc.green('0')}` +
      pc.dim(` unresolved tier-1 (${status.contested_facts} fact(s))`),
  );
}

/** lore canon decay — evaluate TTL and evidence decay, persist trust=stale. */
export function canonDecayCommand(opts: CanonDecayOptions = {}): void {
  const root = requireRoot();
  const db = openDb(root);
  const report = sweepDecay(db, root, { dryRun: opts.dryRun });
  db.close();

  if (opts.json) {
    console.log(JSON.stringify({ schema: 1, dry_run: Boolean(opts.dryRun), ...report }, null, 2));
    return;
  }

  console.log(pc.bold('lore canon decay'));
  if (!report.stale.length) {
    console.log(pc.green(`  0 decayed (${report.checked} live claim(s) checked)`));
    return;
  }
  for (const hit of report.stale) {
    console.log(
      `  ${pc.red(hit.decay.trigger)}  ${pc.cyan(hit.subject)} ${pc.dim('—')} ${pc.bold(hit.predicate)}  ${pc.dim(
        hit.id,
      )}`,
    );
    console.log(pc.dim(`      ${hit.decay.detail}  (was ${hit.trust_before})`));
  }
  console.log(
    opts.dryRun
      ? pc.yellow(`\n  dry run: ${report.stale.length} claim(s) would be marked stale, nothing written`)
      : pc.green(`\n  ${report.stale.length} claim(s) marked stale; rows are kept`),
  );
}

/** lore canon confirm — a human re-asserts a claim, clearing decay. */
export function canonConfirmCommand(claimId: string, opts: CanonConfirmOptions = {}): void {
  const root = requireRoot();
  const db = openDb(root);
  const claim = db.prepare('SELECT * FROM claim WHERE id = ?').get(claimId) as
    | { id: string; state: string; authority: number }
    | undefined;
  if (!claim) throw new Error(`no such claim: ${claimId}`);
  if (claim.state !== 'active') throw new Error(`claim ${claimId} is ${claim.state}, not active; use lore approve for drafts`);

  const principal = requireAction(root, 'approve', { tier: claim.authority });
  const now = new Date().toISOString();

  const trust = db.transaction(() => {
    db.prepare(
      `INSERT INTO evidence(claim_id, kind, ref, hash, commit_id, verified_at, status)
       VALUES (?, 'human', ?, NULL, ?, ?, 'valid')
       ON CONFLICT(claim_id, kind, ref) DO UPDATE SET
         commit_id = COALESCE(excluded.commit_id, evidence.commit_id),
         verified_at = excluded.verified_at,
         status = 'valid'`,
    ).run(claimId, `confirm:${principal.id}`, gitHead(root), now);
    return restoreAfterReverify(db, claimId, { confirm: true });
  })();

  const row = db.prepare('SELECT trust, last_verified_at, confirmations FROM claim WHERE id = ?').get(claimId) as {
    trust: string;
    last_verified_at: string | null;
    confirmations: number;
  };
  db.close();

  if (opts.json) {
    console.log(JSON.stringify({ schema: 1, claim: claimId, principal: principal.id, ...row }, null, 2));
    return;
  }
  console.log(`${pc.green('•')} ${pc.bold(claimId)} ${pc.green(row.trust)} ${pc.dim(`confirmed by ${principal.id}`)}`);
  console.log(pc.dim(`  last verified ${row.last_verified_at}  confirmations ${row.confirmations}`));
  if (trust === 'contested') console.log(pc.yellow('  still contested: resolve the open tier-1 conflict first'));
}

/** lore canon metrics — five outcome numbers, printed and written as JSON. */
export function canonMetricsCommand(opts: CanonMetricsOptions = {}): void {
  const root = requireRoot();
  const db = openDb(root);
  const metrics = canonMetrics(db, root);
  db.close();

  const out = opts.out ? path.resolve(opts.out) : path.join(root, 'canon-metrics.json');
  writeFileSync(out, `${JSON.stringify(metrics, null, 2)}\n`);

  if (opts.json) {
    console.log(JSON.stringify(metrics, null, 2));
    return;
  }

  const m = metrics.metrics;
  console.log(pc.bold('lore canon metrics'));
  console.log(`  stale injection rate              ${m.stale_injection_rate.toFixed(4)}`);
  console.log(`  conflict detection precision      ${m.conflict_detection_precision.toFixed(4)}`);
  console.log(`  explain coverage                  ${m.explain_coverage.toFixed(4)}`);
  console.log(`  candidate -> canonical median     ${m.candidate_to_canonical_median_hours.toFixed(3)} h`);
  console.log(`  first-try failure rate            ${m.first_try_failure_rate.toFixed(4)}`);
  console.log(pc.dim(`  injected ${metrics.totals.injected} of ${metrics.totals.claims} claim(s) on ${metrics.branch}`));
  console.log(pc.dim(`  wrote ${out}`));
}
