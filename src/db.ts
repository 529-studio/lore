import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { SCHEMA } from './schema.js';

export type DB = Database.Database;

/** Walk up until we find a .lore directory. */
export function findStateRoot(start = process.cwd()): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, '.lore'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function dbPathFor(root: string): string {
  return path.join(root, '.lore', 'lore.db');
}

/** Idempotent schema upgrades for stores created by older versions. */
function migrate(db: DB): void {
  const cols = db.prepare('PRAGMA table_info(memory_commit)').all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'merge_parent_id')) {
    db.exec('ALTER TABLE memory_commit ADD COLUMN merge_parent_id TEXT REFERENCES memory_commit(id)');
  }

  const hashCols = db.prepare('PRAGMA table_info(file_hash)').all() as Array<{ name: string }>;
  if (!hashCols.some((c) => c.name === 'ctime_ns')) {
    db.exec("ALTER TABLE file_hash ADD COLUMN ctime_ns TEXT NOT NULL DEFAULT ''");
  }

  const evCols = db.prepare('PRAGMA table_info(evidence)').all() as Array<{ name: string }>;
  if (!evCols.some((c) => c.name === 'commit_id')) {
    db.exec('ALTER TABLE evidence ADD COLUMN commit_id TEXT');
  }
}

export function openDb(root: string): DB {
  const file = dbPathFor(root);
  if (!existsSync(file)) {
    throw new Error(`lore not initialised in ${root} (missing ${path.relative(root, file)}). Run: lore init`);
  }
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export function createDb(root: string): DB {
  mkdirSync(path.join(root, '.lore'), { recursive: true });
  const db = new Database(dbPathFor(root));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export function requireRoot(): string {
  const root = findStateRoot();
  if (!root) {
    throw new Error('not inside a lore repo — run `lore init` first');
  }
  return root;
}
