import pc from 'picocolors';
import { openDb, requireRoot } from '../db.js';
import { activeAt, head, makeCommit, type ClaimRow } from '../model.js';
import { branchFor, currentSession } from '../session.js';
import { resolveRevision } from '../revision.js';

type Op = 'add' | 'supersede' | 'retract' | 'restore';

export function revertCommand(opts: { commit: string; session?: string }): void {
  const root = requireRoot();
  const db = openDb(root);
  const session = currentSession(root, opts.session);
  const ref = branchFor(session);
  const target = resolveRevision(db, opts.commit, root);

  if (!target.id) throw new Error(`unknown commit: ${opts.commit}`);

  const targetRow = db
    .prepare('SELECT id, message, author FROM memory_commit WHERE id = ?')
    .get(target.id) as { id: string; message: string; author: string } | undefined;
  if (!targetRow) throw new Error(`unknown commit: ${opts.commit}`);

  const entries = db
    .prepare('SELECT claim_id, op FROM commit_entry WHERE commit_id = ? ORDER BY rowid')
    .all(target.id) as Array<{ claim_id: string; op: Op }>;

  if (!entries.length) {
    console.log(pc.yellow(`commit ${target.id} touched no claims — nothing to revert`));
    db.close();
    return;
  }

  const current = activeAt(db, head(db, ref) ?? head(db, 'main'));
  const inverse: Array<{ claim_id: string; op: 'add' | 'retract' | 'restore' }> = [];
  const skipped: string[] = [];

  for (const e of entries) {
    const isActive = current.has(e.claim_id);
    if (e.op === 'add' || e.op === 'restore') {
      // The commit put the claim in. Only remove it if it is still there.
      if (isActive) inverse.push({ claim_id: e.claim_id, op: 'retract' });
      else skipped.push(e.claim_id);
    } else if (e.op === 'retract') {
      if (!isActive) inverse.push({ claim_id: e.claim_id, op: 'restore' });
      else skipped.push(e.claim_id);
    } else {
      skipped.push(e.claim_id);
    }
  }

  if (!inverse.length) {
    console.log(pc.yellow('nothing to revert — every claim was already changed since that commit'));
    for (const id of skipped) console.log(pc.dim(`  skipped ${id}`));
    db.close();
    return;
  }

  const commitId = makeCommit(db, {
    ref,
    entries: inverse.map((i) => ({ claim_id: i.claim_id, op: i.op })),
    message: `revert: ${target.id} (${targetRow.message})`,
    author: opts.session ? `agent:${session}` : 'human:cli',
    kind: 'revert',
  });

  console.log(`${pc.green('✓')} reverted ${pc.yellow(target.id)} ${pc.dim(targetRow.message)}`);
  console.log(pc.dim(`  new commit ${commitId} on ${ref}`));

  const stmt = db.prepare('SELECT * FROM claim WHERE id = ?');
  for (const inv of inverse) {
    const row = stmt.get(inv.claim_id) as ClaimRow | undefined;
    const sign = inv.op === 'retract' ? pc.red('-') : pc.green('+');
    const obj = row ? (() => {
      try {
        return String(JSON.parse(row.object_json));
      } catch {
        return row.object_json;
      }
    })() : '?';
    console.log(`  ${sign} ${inv.op.padEnd(8)} ${pc.dim(inv.claim_id)} ${row?.subject_id ?? ''} ${pc.dim('—')} ${row?.predicate ?? ''} ${pc.dim('—')} ${obj}`);
  }
  if (skipped.length) {
    console.log(pc.dim(`  ${skipped.length} claim(s) skipped (changed since that commit)`));
  }
  db.close();
}
