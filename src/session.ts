import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DB } from './db.js';

const SESSION_FILE = '.lore/session';

/** A session maps to a branch: agent/<session>. Stable across CLI invocations. */
export function currentSession(root: string, override?: string): string {
  if (override) return override;
  if (process.env.LORE_SESSION) return process.env.LORE_SESSION;
  const file = path.join(root, SESSION_FILE);
  if (existsSync(file)) {
    const stored = readFileSync(file, 'utf8').trim();
    if (stored) return stored;
  }
  const id = `ses_${Date.now().toString(36)}`;
  writeFileSync(file, id);
  return id;
}

export function branchFor(session: string): string {
  return `agent/${session}`;
}

export function getMeta(db: DB, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setMeta(db: DB, key: string, value: string): void {
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    value,
  );
}
