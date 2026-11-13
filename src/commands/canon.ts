import pc from 'picocolors';
import { openDb, requireRoot } from '../db.js';
import { canonStatus, TRUST_ORDER } from '../canon/status.js';

export interface CanonStatusOptions {
  json?: boolean;
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
