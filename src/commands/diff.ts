import pc from 'picocolors';
import { openDb, requireRoot } from '../db.js';
import type { DB } from '../db.js';
import { activeAt, type ClaimRow } from '../model.js';
import { parseRange, resolveRevision } from '../revision.js';

function loadClaims(db: DB, ids: string[]): Map<string, ClaimRow> {
  const map = new Map<string, ClaimRow>();
  const stmt = db.prepare('SELECT * FROM claim WHERE id = ?');
  for (const id of ids) {
    const row = stmt.get(id) as ClaimRow | undefined;
    if (row) map.set(id, row);
  }
  return map;
}

function objectOf(row: ClaimRow): string {
  try {
    return String(JSON.parse(row.object_json));
  } catch {
    return row.object_json;
  }
}

function line(prefix: string, row: ClaimRow): string {
  return `${prefix} ${pc.dim(row.id)}  ${pc.bold(row.subject_id)} ${pc.dim('—')} ${row.predicate} ${pc.dim('—')} ${objectOf(row)}`;
}

export function diffCommand(opts: { range: string; to?: string }): void {
  const root = requireRoot();
  const db = openDb(root);
  const [fromSpec, toSpec] = parseRange(opts.range, opts.to);
  const from = resolveRevision(db, fromSpec, root);
  const to = resolveRevision(db, toSpec, root);

  if (!from.id) throw new Error(`unknown revision: ${fromSpec}`);
  if (!to.id) throw new Error(`unknown revision: ${toSpec}`);

  const a = activeAt(db, from.id);
  const b = activeAt(db, to.id);

  const added = [...b.keys()].filter((id) => !a.has(id));
  const removed = [...a.keys()].filter((id) => !b.has(id));
  const unchanged = [...b.keys()].filter((id) => a.has(id)).length;

  const rows = loadClaims(db, [...added, ...removed]);

  console.log(`${pc.dim(from.label)} ${pc.dim('..')} ${pc.dim(to.label)}`);
  for (const id of added) {
    const row = rows.get(id);
    if (row) console.log(pc.green(line('+', row)));
  }
  for (const id of removed) {
    const row = rows.get(id);
    if (row) console.log(pc.red(line('-', row)));
  }
  if (!added.length && !removed.length) console.log(pc.dim('  no claim changes'));

  console.log(
    pc.dim(`\n${added.length} added, ${removed.length} removed, ${unchanged} unchanged`),
  );
  db.close();
}
