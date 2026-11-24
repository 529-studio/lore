import Database from 'better-sqlite3';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { SCHEMA } from './schema.js';

export type DB = Database.Database;

/** The repository root a connection belongs to, for modules that receive only the DB. */
const stateRoots = new WeakMap<Database.Database, string>();

export function stateRootFor(db: DB): string | null {
  return stateRoots.get(db) ?? null;
}

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

  db.exec(`
    CREATE TABLE IF NOT EXISTS token_revocation (
      jti        TEXT PRIMARY KEY,
      sub        TEXT NOT NULL,
      reason     TEXT,
      revoked_by TEXT NOT NULL,
      revoked_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS token_revocation_sub ON token_revocation(sub);
  `);
}

function setupTriggers(db: DB): void {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS audit_claim_insert
    AFTER INSERT ON claim
    BEGIN
      INSERT INTO agent_action_log (agent_id, action, table_name, row_id, ts, new_state)
      VALUES (
        NEW.author,
        'INSERT',
        'claim',
        NEW.id,
        datetime('now'),
        json_object('subject_id', NEW.subject_id, 'predicate', NEW.predicate, 'object', NEW.object_json)
      );
    END;

    CREATE TRIGGER IF NOT EXISTS audit_claim_update
    AFTER UPDATE ON claim
    BEGIN
      INSERT INTO agent_action_log (agent_id, action, table_name, row_id, ts, previous_state, new_state)
      VALUES (
        NEW.author,
        'UPDATE',
        'claim',
        NEW.id,
        datetime('now'),
        json_object('subject_id', OLD.subject_id, 'predicate', OLD.predicate, 'object', OLD.object_json),
        json_object('subject_id', NEW.subject_id, 'predicate', NEW.predicate, 'object', NEW.object_json)
      );
    END;

    CREATE TRIGGER IF NOT EXISTS audit_claim_delete
    AFTER DELETE ON claim
    BEGIN
      INSERT INTO agent_action_log (agent_id, action, table_name, row_id, ts, previous_state)
      VALUES (
        OLD.author,
        'DELETE',
        'claim',
        OLD.id,
        datetime('now'),
        json_object('subject_id', OLD.subject_id, 'predicate', OLD.predicate, 'object', OLD.object_json)
      );
    END;

    CREATE TRIGGER IF NOT EXISTS audit_commit_insert
    AFTER INSERT ON memory_commit
    BEGIN
      INSERT INTO agent_action_log (agent_id, action, table_name, row_id, ts, new_state)
      VALUES (
        NEW.author,
        'INSERT',
        'memory_commit',
        NEW.id,
        datetime('now'),
        json_object('message', NEW.message, 'kind', NEW.kind)
      );
    END;
  `);
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
  setupTriggers(db);
  stateRoots.set(db, root);
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
  setupTriggers(db);
  stateRoots.set(db, root);
  return db;
}

export function requireRoot(): string {
  const root = findStateRoot();
  if (!root) {
    throw new Error('not inside a lore repo — run `lore init` first');
  }
  return root;
}

export type WalCheckpointMode = 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE';

export interface WalCheckpointResult {
  busy: boolean;
  log: number;
  checkpointed: number;
}

export interface WalStats {
  pageSize: number;
  autocheckpointPages: number;
  walFrames: number;
  checkpointedFrames: number;
  walSizeBytes: number;
  dbSizeBytes: number;
}

/**
 * Executes a SQLite WAL checkpoint with the specified mode.
 * Safe against concurrent readers/writers; handles busy status without throwing.
 */
export function checkpointWal(db: DB, mode: WalCheckpointMode = 'PASSIVE'): WalCheckpointResult {
  const rows = db.pragma(`wal_checkpoint(${mode})`) as Array<{ busy: number; log: number; checkpointed: number }>;
  const row = rows[0] ?? { busy: 0, log: 0, checkpointed: 0 };
  return {
    busy: row.busy !== 0,
    log: Number(row.log ?? 0),
    checkpointed: Number(row.checkpointed ?? 0),
  };
}

/**
 * Retrieves comprehensive WAL and database storage metrics.
 */
export function getWalStats(db: DB, root?: string): WalStats {
  const effectiveRoot = root ?? stateRootFor(db);
  const pageSize = Number(db.pragma('page_size', { simple: true }));
  const autocheckpointPages = Number(db.pragma('wal_autocheckpoint', { simple: true }));

  // Non-blocking passive checkpoint to retrieve log frame count and checkpointed frame count
  const rows = db.pragma('wal_checkpoint(PASSIVE)') as Array<{ busy: number; log: number; checkpointed: number }>;
  const row = rows[0] ?? { busy: 0, log: 0, checkpointed: 0 };

  let walSizeBytes = 0;
  let dbSizeBytes = 0;

  if (effectiveRoot) {
    const dbFile = dbPathFor(effectiveRoot);
    const walFile = `${dbFile}-wal`;
    if (existsSync(dbFile)) {
      try {
        dbSizeBytes = statSync(dbFile).size;
      } catch {
        // ignore
      }
    }
    if (existsSync(walFile)) {
      try {
        walSizeBytes = statSync(walFile).size;
      } catch {
        // ignore
      }
    }
  }

  return {
    pageSize,
    autocheckpointPages,
    walFrames: Number(row.log ?? 0),
    checkpointedFrames: Number(row.checkpointed ?? 0),
    walSizeBytes,
    dbSizeBytes,
  };
}
