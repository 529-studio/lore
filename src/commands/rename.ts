import pc from 'picocolors';
import { openDb, requireRoot } from '../db.js';
import { makeCommit } from '../model.js';
import { branchFor, ensureSession } from '../session.js';

export interface RenameOptions {
  old: string;
  new: string;
  author?: string;
  session?: string;
}

const stripPrefix = (value: string): string => value.replace(/^(?:file|doc|sym):/, '');

/**
 * Move entities and evidence when a file is renamed. Claim ids are content hashes
 * and stay unchanged (the same trade-off as redaction); the audit row records it.
 */
export function renameCommand(opts: RenameOptions): void {
  const root = requireRoot();
  const db = openDb(root);
  const session = ensureSession(db, root, opts.session);
  const ref = branchFor(session);

  const oldPath = stripPrefix(opts.old);
  const newPath = stripPrefix(opts.new);
  if (oldPath === newPath) throw new Error('old and new paths are identical');

  const entities = db
    .prepare(
      `SELECT id, kind, canonical, created_at FROM entity
       WHERE id = ? OR id = ? OR id = ?
          OR id LIKE ? OR id LIKE ? OR id LIKE ?`,
    )
    .all(
      `doc:${oldPath}`,
      `file:${oldPath}`,
      `sym:${oldPath}`,
      `doc:${oldPath}#%`,
      `file:${oldPath}#%`,
      `sym:${oldPath}#%`,
    ) as Array<{ id: string; kind: string; canonical: string; created_at: string }>;

  if (!entities.length) throw new Error(`no entities for ${oldPath}`);

  const actor = opts.author ?? 'human:cli';
  let moved = 0;

  const apply = db.transaction(() => {
    const insertEntity = db.prepare(
      'INSERT OR IGNORE INTO entity(id, kind, canonical, created_at) VALUES (?, ?, ?, ?)',
    );
    const updateClaim = db.prepare('UPDATE claim SET subject_id = ? WHERE subject_id = ?');

    for (const entity of entities) {
      const newId = entity.id.split(oldPath).join(newPath);
      insertEntity.run(newId, entity.kind, entity.canonical.split(oldPath).join(newPath), entity.created_at);
      moved += updateClaim.run(newId, entity.id).changes;
    }

    const refs = db
      .prepare("SELECT DISTINCT ref FROM evidence WHERE ref = ? OR ref LIKE ?")
      .all(oldPath, `${oldPath}/%`) as Array<{ ref: string }>;
    const updateRef = db.prepare('UPDATE evidence SET ref = ? WHERE ref = ?');
    for (const row of refs) {
      updateRef.run(row.ref.split(oldPath).join(newPath), row.ref);
    }

    db.prepare(
      `INSERT INTO alias(alias, entity_id, created_at, author) VALUES (?, ?, ?, ?)
       ON CONFLICT(alias) DO UPDATE SET entity_id = excluded.entity_id`,
    ).run(oldPath, `doc:${newPath}`, new Date().toISOString(), actor);

    db.prepare('INSERT INTO rename_audit(old_path, new_path, actor, claims, ts) VALUES (?, ?, ?, ?, ?)').run(
      oldPath,
      newPath,
      actor,
      moved,
      new Date().toISOString(),
    );

    makeCommit(db, {
      ref,
      entries: [],
      message: `rename: ${oldPath} -> ${newPath} (${moved} claims)`,
      author: actor,
      kind: 'write',
    });
  });
  apply();

  console.log(`${pc.green('✓')} renamed ${oldPath} -> ${newPath}`);
  console.log(pc.dim(`  ${entities.length} entities, ${moved} claims, evidence refs updated`));
  console.log(pc.dim(`  alias "${oldPath}" -> doc:${newPath}`));
  db.close();
}
