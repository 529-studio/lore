import type { DB } from '../db.js';
import { createSyncAdapter as createLitestreamAdapter } from './litestream.js';

export interface SyncPullResult {
  entities: number;
  claims: number;
  commits: number;
  merge: 'none' | 'up-to-date' | 'fast-forward' | 'three-way';
}

export interface SyncPushResult {
  walCheckpointed: boolean;
  tip: string | null;
  actionId?: number;
}

export interface SyncOptions {
  replicaUrl: string;
  execPath?: string;
  configPath?: string;
}

export interface SyncAdapter {
  pull(opts?: { author?: string }): Promise<SyncPullResult>;
  push(opts?: { author?: string }): Promise<SyncPushResult>;
}

export async function createSyncAdapter(db: DB, root: string, opts: SyncOptions): Promise<SyncAdapter> {
  return createLitestreamAdapter(db, root, opts);
}
