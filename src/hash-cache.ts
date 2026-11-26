import { realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { DB } from './db.js';
import { hashFile, resolveInside } from './extract/index.js';

/** Stable id for a checkout; file paths are only unique inside one workspace. */
function workspaceIdFor(root: string): string {
  let real = path.resolve(root);
  try {
    real = realpathSync(real);
  } catch {
    // keep the resolved path
  }
  return createHash('sha1').update(real).digest('hex').slice(0, 16);
}

export interface CacheStats {
  hits: number;
  misses: number;
  reads: number;
  enabled: boolean;
}

interface CachedRow {
  size: number;
  mtime_ns: string;
  ctime_ns: string;
  hash: string;
}

/**
 * Per-connection hash cache keyed by (size, mtime). A second pass over an
 * unchanged repository performs zero content reads; touching a file invalidates
 * only that file. `--no-cache` bypasses it when correctness is in doubt.
 */
export class HashCache {
  hits = 0;
  misses = 0;
  reads = 0;
  enabled = process.env.LORE_NO_CACHE !== '1';
  private readonly workspaceId: string;

  constructor(
    private readonly db: DB,
    private readonly root: string,
  ) {
    this.workspaceId = workspaceIdFor(root);
  }

  hash(rel: string): string | null {
    const real = resolveInside(this.root, rel);
    if (!real) return null;

    let stat;
    try {
      stat = statSync(real, { bigint: true });
    } catch {
      return null;
    }
    const size = Number(stat.size);
    const mtime = stat.mtimeNs.toString();
    // ctime changes on any inode write, including when mtime is restored with
    // touch -r, so it closes the "same size, same mtime" false negative.
    const ctime = stat.ctimeNs.toString();

    if (this.enabled) {
      const row = this.db
        .prepare('SELECT size, mtime_ns, ctime_ns, hash FROM file_hash WHERE workspace_id = ? AND path = ?')
        .get(this.workspaceId, rel) as CachedRow | undefined;
      if (row && row.size === size && row.mtime_ns === mtime && row.ctime_ns === ctime) {
        this.hits += 1;
        return row.hash;
      }
    }

    this.misses += 1;
    this.reads += 1;
    const hash = hashFile(this.root, rel);
    if (hash && this.enabled) {
      this.db
        .prepare(
          `INSERT INTO file_hash(workspace_id, path, size, mtime_ns, ctime_ns, hash, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(workspace_id, path) DO UPDATE SET
             size = excluded.size, mtime_ns = excluded.mtime_ns, ctime_ns = excluded.ctime_ns,
             hash = excluded.hash, checked_at = excluded.checked_at`,
        )
        .run(this.workspaceId, rel, size, mtime, ctime, hash, new Date().toISOString());
    }
    return hash;
  }

  stats(): CacheStats {
    return { hits: this.hits, misses: this.misses, reads: this.reads, enabled: this.enabled };
  }
}

const caches = new WeakMap<DB, Map<string, HashCache>>();

export function hashCache(db: DB, root: string): HashCache {
  const key = path.resolve(root);
  let byRoot = caches.get(db);
  if (!byRoot) {
    byRoot = new Map();
    caches.set(db, byRoot);
  }
  let cache = byRoot.get(key);
  if (!cache) {
    cache = new HashCache(db, key);
    byRoot.set(key, cache);
  }
  return cache;
}

export function setHashCacheEnabled(db: DB, root: string, enabled: boolean): void {
  hashCache(db, root).enabled = enabled;
}

/** Drop cache rows that have not been checked in `days`. Called by gc. */
export function pruneHashCache(db: DB, days = 30): number {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const info = db.prepare('DELETE FROM file_hash WHERE checked_at < ?').run(cutoff);
  return info.changes;
}
