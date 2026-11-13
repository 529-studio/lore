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

  // Backfill reads evidence.commit_id, so the evidence column must exist first.
  const evCols = db.prepare('PRAGMA table_info(evidence)').all() as Array<{ name: string }>;
  if (!evCols.some((c) => c.name === 'commit_id')) {
    db.exec('ALTER TABLE evidence ADD COLUMN commit_id TEXT');
  }

  const claimCols = db.prepare('PRAGMA table_info(claim)').all() as Array<{ name: string }>;
  const claimAdditions: Array<[string, string]> = [
    ['trust', "TEXT NOT NULL DEFAULT 'candidate'"],
    ['ttl_days', 'INTEGER'],
    ['last_verified_at', 'TEXT'],
    ['confirmations', 'INTEGER NOT NULL DEFAULT 0'],
    ['contradictions', 'INTEGER NOT NULL DEFAULT 0'],
    ['invalidated_by_json', 'TEXT'],
    ['written_by', "TEXT NOT NULL DEFAULT 'legacy'"],
    ['agent_id', 'TEXT'],
    ['session_id', 'TEXT'],
    ['run_id', 'TEXT'],
    ['tags_json', "TEXT NOT NULL DEFAULT '[]'"],
  ];
  for (const [name, type] of claimAdditions) {
    if (!claimCols.some((c) => c.name === name)) {
      db.exec(`ALTER TABLE claim ADD COLUMN ${name} ${type}`);
    }
  }

  const backfilled = db.prepare("SELECT value FROM meta WHERE key = 'canon_backfill_v1'").get();
  if (!backfilled) {
    db.exec(`
      UPDATE claim SET trust = CASE
        WHEN state = 'retracted' THEN 'retracted'
        WHEN state = 'draft' THEN 'candidate'
        WHEN EXISTS (
          SELECT 1 FROM evidence e
          WHERE e.claim_id = claim.id AND (e.hash IS NOT NULL OR e.commit_id IS NOT NULL)
        ) THEN 'canonical'
        ELSE 'candidate'
      END;
      UPDATE claim SET written_by = CASE
        WHEN author LIKE 'agent:%' THEN 'agent'
        WHEN author LIKE 'human:%' THEN 'human'
        ELSE 'legacy'
      END;
      UPDATE claim SET last_verified_at = COALESCE(
        (SELECT MAX(e.verified_at) FROM evidence e WHERE e.claim_id = claim.id),
        tx_from
      );
    `);
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('canon_backfill_v1', ?)").run(
      new Date().toISOString(),
    );
  }

  const decisionCols = db.prepare('PRAGMA table_info(merge_decision)').all() as Array<{ name: string }>;
  if (!decisionCols.some((c) => c.name === 'actor')) {
    db.exec('ALTER TABLE merge_decision ADD COLUMN actor TEXT');
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
