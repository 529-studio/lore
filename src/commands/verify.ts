import pc from 'picocolors';
import { openDb, requireRoot } from '../db.js';
import { activeAt, head, type ClaimRow } from '../model.js';
import { branchFor, currentSession, ensureSession } from '../session.js';
import { verifyClaim } from '../retrieval.js';

export interface VerifyOptions {
  claim?: string;
  all?: boolean;
  strict?: boolean;
  accept?: boolean;
}

/**
 * lore verify — rehash file/test evidence, write evidence.status, and report.
 * Exit code 3 when `--all --strict` still finds stale claims (SPEC §10.1).
 */
export function verifyCommand(opts: VerifyOptions): void {
  const root = requireRoot();
  const db = openDb(root);

  const runOne = (claimId: string): boolean => {
    const result = verifyClaim(db, root, claimId, { accept: opts.accept });
    if (result.checked === 0 && !db.prepare('SELECT id FROM claim WHERE id = ?').get(claimId)) {
      console.log(pc.red(`no such claim: ${claimId}`));
      return false;
    }
    if (result.checked === 0) {
      console.log(`${pc.dim('•')} ${claimId} ${pc.dim('no file/test evidence to rehash — valid')}`);
      return true;
    }
    const label = result.ok ? pc.green('valid') : pc.red('stale');
    console.log(`${result.ok ? pc.green('•') : pc.red('•')} ${claimId} ${label} ${pc.dim(`(${result.checked} evidence rehashed)`)}`);
    for (const ref of result.stale) console.log(pc.dim(`    ↳ mismatch: ${ref}`));
    return result.ok;
  };

  if (opts.claim) {
    runOne(opts.claim);
    db.close();
    return;
  }

  if (!opts.all) {
    console.log(pc.yellow('use `lore verify <claimId>` or `lore verify --all`'));
    db.close();
    return;
  }

  const session = ensureSession(db, root);
  const branch = branchFor(session);
  const tip = head(db, branch) ?? head(db, 'main');
  const active = activeAt(db, tip);

  const rows: ClaimRow[] = [];
  const stmt = db.prepare('SELECT * FROM claim WHERE id = ?');
  for (const id of active.keys()) {
    const row = stmt.get(id) as ClaimRow | undefined;
    if (row) rows.push(row);
  }

  let okCount = 0;
  let staleCount = 0;
  let checked = 0;
  for (const c of rows) {
    const result = verifyClaim(db, root, c.id, { accept: opts.accept });
    checked += result.checked;
    if (result.stale.length) {
      staleCount++;
      console.log(`${pc.red('•')} ${c.id} ${pc.bold(c.predicate)} ${pc.dim('stale')}`);
      for (const ref of result.stale) console.log(pc.dim(`    ↳ mismatch: ${ref}`));
    } else {
      okCount++;
    }
  }

  console.log(
    `\n${rows.length} claim(s): ${pc.green(`${okCount} valid`)} ${staleCount ? pc.red(`${staleCount} stale`) : pc.green('0 stale')} ${pc.dim(`— ${checked} evidence rehashed`)}`,
  );

  if (opts.strict && staleCount > 0) {
    process.exitCode = 3;
  }
  db.close();
}
