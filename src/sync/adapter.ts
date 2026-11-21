import type { DB } from '../db.js';
import { createSyncAdapter as createLitestreamAdapter } from './litestream.js';

export interface SyncAdapter {
  pull(): Promise<void>;
  push(): Promise<void>;
}

export interface SyncOptions {
  replicaUrl: string;
}

export async function createSyncAdapter(db: DB, root: string, opts: SyncOptions): Promise<SyncAdapter> {
  return createLitestreamAdapter(db, root, opts);
}
