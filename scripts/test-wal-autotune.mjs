#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDb, checkpointWal, getWalStats } from '../dist/db.js';

console.log('[TEST] Checking WAL primitives: checkpointWal and getWalStats...');
const work = mkdtempSync(path.join(tmpdir(), 'lore-test-wal-'));

try {
  const db = createDb(work);
  const stats = getWalStats(db, work);
  assert.equal(typeof stats.pageSize, 'number');
  assert.ok(stats.pageSize >= 512);
  assert.equal(typeof stats.autocheckpointPages, 'number');
  assert.ok(stats.autocheckpointPages >= 10);
  assert.equal(typeof stats.walFrames, 'number');
  assert.equal(typeof stats.checkpointedFrames, 'number');
  assert.equal(typeof stats.dbSizeBytes, 'number');
  assert.ok(stats.dbSizeBytes > 0);

  const checkpointRes = checkpointWal(db, 'PASSIVE');
  assert.equal(typeof checkpointRes.busy, 'boolean');
  assert.equal(checkpointRes.busy, false);
  assert.equal(typeof checkpointRes.log, 'number');
  assert.equal(typeof checkpointRes.checkpointed, 'number');

  db.close();
  console.log('[OK] WAL primitives assertions passed');
} finally {
  rmSync(work, { recursive: true, force: true });
}
