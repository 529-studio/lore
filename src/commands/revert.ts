import pc from 'picocolors';
import { openDb, requireRoot } from '../db.js';
import { revertCommit } from '../actions.js';
import type { ClaimRow } from '../model.js';
import { branchFor, ensureSession } from '../session.js';

export function revertCommand(opts: { commit: string; session?: string }): void {
  const root = requireRoot();
  const db = openDb(root);
  const session = ensureSession(db, root, opts.session);
  const ref = branchFor(session);

  const result = revertCommit(db, root, ref, opts.commit);

  console.log(`${pc.green('✓')} reverted ${pc.yellow(opts.commit)} as ${result.principal.id}`);
  console.log(pc.dim(`  new commit ${result.commitId} on ${ref}`));

  const stmt = db.prepare('SELECT * FROM claim WHERE id = ?');
  for (const change of result.changed) {
    const row = stmt.get(change.claim_id) as ClaimRow | undefined;
    const sign = change.op === 'retract' ? pc.red('-') : pc.green('+');
    const object = row
      ? (() => {
          try {
            return String(JSON.parse(row.object_json));
          } catch {
            return row.object_json;
          }
        })()
      : '?';
    console.log(
      `  ${sign} ${change.op.padEnd(8)} ${pc.dim(change.claim_id)} ${row?.subject_id ?? ''} ${pc.dim('—')} ${row?.predicate ?? ''} ${pc.dim('—')} ${object}`,
    );
  }
  for (const skip of result.skipped) console.log(pc.dim(`  skipped ${skip.claim_id} (${skip.reason})`));
  db.close();
}
