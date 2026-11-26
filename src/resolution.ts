import type { DB } from './db.js';

/** Resolution rows are keyed by (subject, predicate); the merge plan uses the same key. */
export const SEP = '\u0000';

export type Take = 'ours' | 'theirs' | 'both';

/**
 * Manual decisions that `lore resolve` recorded but no merge has consumed yet.
 * Shared by `lore merge`, `lore promote` and the sync merge, so a resolution
 * recorded to unblock one path also unblocks the other.
 */
export function loadPending(db: DB): Map<string, Take> {
  const rows = db
    .prepare('SELECT subject_id, predicate, take FROM resolution WHERE applied = 0')
    .all() as Array<{ subject_id: string; predicate: string; take: Take }>;
  return new Map(rows.map((r) => [`${r.subject_id}${SEP}${r.predicate}`, r.take]));
}

/** Mark every pending decision consumed by the merge that just committed. */
export function markResolutionsApplied(db: DB): void {
  db.prepare('UPDATE resolution SET applied = 1 WHERE applied = 0').run();
  db.prepare('UPDATE merge_conflict SET resolved = 1 WHERE resolved = 0').run();
}
