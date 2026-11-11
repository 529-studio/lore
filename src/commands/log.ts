import pc from 'picocolors';
import { openDb, requireRoot } from '../db.js';
import type { DB } from '../db.js';
import { head } from '../model.js';
import { branchFor, currentSession, ensureSession } from '../session.js';

interface CommitRow {
  id: string;
  parent_id: string | null;
  tree_hash: string;
  message: string;
  author: string;
  ts: string;
  kind: string;
}

function chain(db: DB, tip: string | null): CommitRow[] {
  const rows: CommitRow[] = [];
  let cursor = tip;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const row = db.prepare('SELECT * FROM memory_commit WHERE id = ?').get(cursor) as CommitRow | undefined;
    if (!row) break;
    rows.push(row);
    cursor = row.parent_id;
  }
  return rows;
}

export function logCommand(opts: { limit?: string; session?: string; graph?: boolean }): void {
  const root = requireRoot();
  const db = openDb(root);
  const session = ensureSession(db, root, opts.session);
  const ref = branchFor(session);
  const tip = head(db, ref) ?? head(db, 'main');
  const limit = Number(opts.limit ?? 20);

  const rows = chain(db, tip).slice(0, limit);
  if (!rows.length) {
    console.log(pc.dim('no commits yet'));
    return;
  }

  console.log(pc.dim(`branch ${ref}  (${rows.length} commit${rows.length === 1 ? '' : 's'})`));
  for (const row of rows) {
    const entries = db
      .prepare('SELECT claim_id, op FROM commit_entry WHERE commit_id = ? ORDER BY rowid')
      .all(row.id) as Array<{ claim_id: string; op: string }>;
    const when = row.ts.replace('T', ' ').slice(0, 16);
    const graph = opts.graph ? pc.dim('* ') : '';
    console.log(
      `${graph}${pc.yellow(row.id)} ${pc.dim(when)} ${pc.cyan(row.kind.padEnd(6))} ${row.message} ${pc.dim(`(${row.author})`)}`,
    );
    for (const e of entries.slice(0, 4)) {
      const sign = e.op === 'retract' ? pc.red('-') : pc.green('+');
      console.log(pc.dim('| ') + `${sign} ${pc.dim(e.op.padEnd(9))} ${e.claim_id}`);
    }
    if (entries.length > 4) console.log(pc.dim(`| … and ${entries.length - 4} more claim(s)`));
    if (entries.length) console.log(pc.dim('|'));
  }
  db.close();
}
