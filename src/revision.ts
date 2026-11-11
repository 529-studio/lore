import type { DB } from './db.js';
import { head } from './model.js';
import { branchFor, currentSession } from './session.js';

export interface Revision {
  id: string | null;
  label: string;
}

/**
 * Accepts: ref name (main, agent/<ses>), HEAD, full or short commit id.
 */
export function resolveRevision(db: DB, spec: string, root?: string): Revision {
  if (spec === 'HEAD') {
    const session = root ? currentSession(root) : '';
    const ref = branchFor(session);
    const id = head(db, ref) ?? head(db, 'main');
    return { id, label: ref };
  }

  const byRef = head(db, spec);
  if (byRef) return { id: byRef, label: spec };

  const normalized = spec.startsWith('k_') ? spec : `k_${spec}`;
  const row = db
    .prepare('SELECT id FROM memory_commit WHERE id = ? OR id LIKE ? LIMIT 1')
    .get(normalized, `${normalized}%`) as { id: string } | undefined;
  if (row) return { id: row.id, label: row.id };

  return { id: null, label: spec };
}

export function parseRange(range: string, to?: string): [string, string] {
  if (to) return [range, to];
  const idx = range.indexOf('..');
  if (idx === -1) throw new Error(`expected <from>..<to> or two arguments, got "${range}"`);
  return [range.slice(0, idx), range.slice(idx + 2)];
}
