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

  console.log('[TEST] Checking burst writes and TRUNCATE checkpoint recovery...');
  const dbBurst = openDb(work);
  tuneWalCheckpoint(dbBurst, work, { autocheckpointPages: 25 });

  const insertEntity = dbBurst.prepare(`
    INSERT OR IGNORE INTO entity (id, kind, canonical, created_at)
    VALUES (?, 'symbol', ?, datetime('now'))
  `);

  const insertStmt = dbBurst.prepare(`
    INSERT INTO claim (id, subject_id, predicate, object_json, tx_from, authority, confidence, author, state, trust, written_by)
    VALUES (?, ?, 'defines_rule', '"wal test"', datetime('now'), 1, 1.0, 'test', 'active', 'canonical', 'agent')
  `);

  const burstTx = dbBurst.transaction((count) => {
    for (let i = 0; i < count; i++) {
      const subject = `sym:burst_${i}`;
      insertEntity.run(subject, subject);
      insertStmt.run(`c_burst_${i}_${Date.now()}`, subject);
    }
  });

  burstTx(500);

  const statsDuring = getWalStats(dbBurst, work);
  assert.ok(statsDuring.walFrames > 0, `Expected walFrames > 0 during writes, got ${statsDuring.walFrames}`);
  assert.ok(statsDuring.walSizeBytes > 0, `Expected walSizeBytes > 0 during writes, got ${statsDuring.walSizeBytes}`);

  // TRUNCATE checkpoint flushes WAL and resets the WAL file size to 0 bytes
  const truncateRes = checkpointWal(dbBurst, 'TRUNCATE');
  assert.equal(truncateRes.busy, false);

  const statsAfter = getWalStats(dbBurst, work);
  assert.equal(statsAfter.walFrames, 0, `Expected 0 walFrames after TRUNCATE, got ${statsAfter.walFrames}`);
  assert.equal(statsAfter.walSizeBytes, 0, `Expected 0 walSizeBytes after TRUNCATE, got ${statsAfter.walSizeBytes}`);

  const integrityCheck = dbBurst.prepare('PRAGMA integrity_check').all();
  assert.equal(integrityCheck.length, 1);
  assert.equal(integrityCheck[0].integrity_check, 'ok');

  dbBurst.close();
  console.log('[OK] Burst writes and checkpoint recovery assertions passed');
} finally {
  rmSync(work, { recursive: true, force: true });
}
