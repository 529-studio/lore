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

export function openDb(root: string): DB {
  const file = dbPathFor(root);
  if (!existsSync(file)) {
    throw new Error(`lore not initialised in ${root} (missing ${path.relative(root, file)}). Run: lore init`);
  }
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

export function createDb(root: string): DB {
  mkdirSync(path.join(root, '.lore'), { recursive: true });
  const db = new Database(dbPathFor(root));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

export function requireRoot(): string {
  const root = findStateRoot();
  if (!root) {
    throw new Error('not inside a lore repo — run `lore init` first');
  }
  return root;
}
