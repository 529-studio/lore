import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { DB } from './db.js';
import { stateDirFor } from './scope.js';
import { gitDir, isLinkedGitWorktree } from './util/git.js';
import { runSessionHook } from './plugins/loader.js';

const SESSION_FILE = 'session';
const FIRED_SESSION_HOOKS = new Set<string>();

/**
 * A session maps to a branch: agent/<session>. The session file follows the
 * checkout, not the shared store: each linked worktree gets its own deterministic
 * id unless `LORE_SESSION` is set, so concurrent worktrees never share a branch.
 */
function sessionFileFor(root: string): string {
  if (isLinkedGitWorktree(root)) {
    const dir = gitDir(root);
    if (dir) return path.join(dir, 'lore-session');
  }
  return path.join(stateDirFor(root), SESSION_FILE);
}

function worktreeSession(root: string): string {
  const digest = createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 10);
  return `wt_${digest}`;
}

/** A session maps to a branch: agent/<session>. Stable across CLI invocations. */
export function currentSession(root: string, override?: string): string {
  if (override) return override;
  if (process.env.LORE_SESSION) return process.env.LORE_SESSION;
  const file = sessionFileFor(root);
  if (existsSync(file)) {
    const stored = readFileSync(file, 'utf8').trim();
    if (stored) return stored;
  }
  const id = isLinkedGitWorktree(root) ? worktreeSession(root) : `ses_${Date.now().toString(36)}`;
  writeFileSync(file, `${id}\n`);
  return id;
}

/** Rotate the active session to a fresh ID in the checkout's session file. */
export function rotateSession(root: string): string {
  const file = sessionFileFor(root);
  const id = `ses_${Date.now().toString(36)}`;
  writeFileSync(file, `${id}\n`);
  return id;
}

/** Register the current session so GC can count how many ran after a draft was created. */
export function ensureSession(db: DB, root: string, override?: string): string {
  const id = currentSession(root, override);
  if (!FIRED_SESSION_HOOKS.has(id)) {
    FIRED_SESSION_HOOKS.add(id);
    runSessionHook(
      'beforeSession',
      { workspaceRoot: path.resolve(root), stateDir: stateDirFor(root), session: id },
      (message) => console.error(`[WARN] ${message}`),
    );
  }
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
