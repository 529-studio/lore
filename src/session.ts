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

/** Register the current session so GC can count how many ran after a draft was created. */
export function ensureSession(db: DB, root: string, override?: string): string {
  const id = currentSession(root, override);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO session(id, started_at, last_seen_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
  ).run(id, now, now);
  return id;
}

/** Record that a human actually looked at these claims in this session. */
export function recordReads(db: DB, session: string, claimIds: string[]): void {
  if (!claimIds.length) return;
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO claim_read(claim_id, session_id, ts) VALUES (?, ?, ?)
     ON CONFLICT(claim_id, session_id) DO UPDATE SET ts = excluded.ts`,
  );
  for (const id of claimIds) stmt.run(id, session, now);
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
