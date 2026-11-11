import { statSync } from 'node:fs';
import type { DB } from './db.js';
import { hashFile, resolveInside } from './extract/index.js';

export interface CacheStats {
  hits: number;
  misses: number;
  reads: number;
  enabled: boolean;
}

interface CachedRow {
  size: number;
  mtime_ns: string;
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
  enabled = true;

  constructor(
    private readonly db: DB,
    private readonly root: string,
  ) {}

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

    if (this.enabled) {
      const row = this.db
        .prepare('SELECT size, mtime_ns, hash FROM file_hash WHERE path = ?')
        .get(rel) as CachedRow | undefined;
      if (row && row.size === size && row.mtime_ns === mtime) {
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
          `INSERT INTO file_hash(path, size, mtime_ns, hash, checked_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET
             size = excluded.size, mtime_ns = excluded.mtime_ns,
             hash = excluded.hash, checked_at = excluded.checked_at`,
        )
        .run(rel, size, mtime, hash, new Date().toISOString());
    }
    return hash;
  }

  stats(): CacheStats {
    return { hits: this.hits, misses: this.misses, reads: this.reads, enabled: this.enabled };
  }
}

const caches = new WeakMap<DB, HashCache>();

export function hashCache(db: DB, root: string): HashCache {
  let cache = caches.get(db);
  if (!cache) {
    cache = new HashCache(db, root);
    caches.set(db, cache);
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
