import pc from 'picocolors';
import { openDb, requireRoot } from '../db.js';

export interface DigestOptions {
  days?: string;
}

export function digestCommand(opts: DigestOptions): void {
  const root = requireRoot();
  const db = openDb(root);
  const days = Number(opts.days ?? 7);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const one = (sql: string): number => (db.prepare(sql).get(since) as { n: number }).n;

  const added = one('SELECT COUNT(*) AS n FROM claim WHERE tx_from >= ?');
  const commits = one('SELECT COUNT(*) AS n FROM memory_commit WHERE ts >= ?');
  const decisions = one('SELECT COUNT(*) AS n FROM merge_decision WHERE ts >= ?');
  const attestations = one('SELECT COUNT(*) AS n FROM attestation WHERE ts >= ?');
  const disagreements = one("SELECT COUNT(*) AS n FROM attestation WHERE ts >= ? AND verdict = 'disagree'");
  const redactions = one('SELECT COUNT(*) AS n FROM redaction WHERE ts >= ?');
  const purges = one('SELECT COUNT(*) AS n FROM purge_audit WHERE ts >= ?');
  const machineApprovals = one(
    "SELECT COUNT(*) AS n FROM memory_commit WHERE ts >= ? AND author LIKE 'machine:%' AND message LIKE 'approve:%'",
  );

  console.log(pc.bold(`lore digest — last ${days} day(s)`));
  console.log(`  claims added        ${pc.bold(String(added))}`);
  console.log(`  commits             ${commits}`);
  console.log(`  conflicts resolved  ${decisions}`);
  console.log(`  attestations        ${attestations}${disagreements ? pc.red(` (${disagreements} disagree)`) : ''}`);
  console.log(`  machine approvals   ${machineApprovals}`);
  console.log(`  redactions          ${redactions}`);
  console.log(`  purges              ${purges}`);
  console.log(pc.dim('  review the rules and the disagreements, not every claim'));
  db.close();
}
