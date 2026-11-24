#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDb, checkpointWal, getWalStats, tuneWalCheckpoint, openDb } from '../dist/db.js';

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

  console.log('[OK] WAL primitives assertions passed');

  console.log('[TEST] Checking tuneWalCheckpoint hierarchy and adaptive scaling...');
  
  // 1. Default / Adaptive
  const resDefault = tuneWalCheckpoint(db, work);
  assert.ok(['default', 'adaptive'].includes(resDefault.source));
  assert.ok(resDefault.activeThreshold >= 10);

  // 2. Explicit options
  const resOpts = tuneWalCheckpoint(db, work, { autocheckpointPages: 250 });
  assert.equal(resOpts.source, 'options');
  assert.equal(resOpts.activeThreshold, 250);

  // 3. Target WAL size in KB
  const resTarget = tuneWalCheckpoint(db, work, { targetWalSizeKb: 1024 });
  assert.equal(resTarget.source, 'options');
  assert.equal(resTarget.activeThreshold, Math.floor((1024 * 1024) / resTarget.pageSize));

  // 4. Config file (.lore/config.json)
  const configPath = path.join(work, '.lore', 'config.json');
  writeFileSync(configPath, JSON.stringify({ repo_id: 'test-wal', wal: { autocheckpoint_pages: 500 } }, null, 2), 'utf8');
  const resConfig = tuneWalCheckpoint(db, work);
  assert.equal(resConfig.source, 'config');
  assert.equal(resConfig.activeThreshold, 500);

  // 5. Environment variable override (takes precedence over config)
  process.env.LORE_WAL_AUTOCHECKPOINT = '750';
  const resEnv = tuneWalCheckpoint(db, work);
  assert.equal(resEnv.source, 'env');
  assert.equal(resEnv.activeThreshold, 750);
  delete process.env.LORE_WAL_AUTOCHECKPOINT;

  db.close();

  // 6. Lifecycle integration: openDb and createDb auto-apply config/env
  const dbReopened = openDb(work);
  const reopenedStats = getWalStats(dbReopened, work);
  assert.equal(reopenedStats.autocheckpointPages, 500);
  dbReopened.close();

  console.log('[OK] tuneWalCheckpoint hierarchy assertions passed');
} finally {
  rmSync(work, { recursive: true, force: true });
}
