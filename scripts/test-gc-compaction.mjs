import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, openDb } from '../dist/db.js';
import {
  tombstoneCandidates,
  purgeTombstones,
  getDatabaseStorageStats,
  compactDatabase,
} from '../dist/gc.js';

const dir = mkdtempSync(join(tmpdir(), 'lore-gc-test-'));

try {
  const db = createDb(dir);

  console.log('[TEST] Checking database storage statistics and compaction on empty db...');
  const initialStats = getDatabaseStorageStats(db);
  assert.ok(initialStats.pageSize > 0, 'pageSize must be positive');
  assert.ok(initialStats.pageCount >= 1, 'pageCount must be at least 1');
  assert.equal(typeof initialStats.freelistPages, 'number');

  console.log('[TEST] Checking tombstone candidates detection...');
  // Setup entity
  db.prepare("INSERT INTO entity (id, kind, canonical, created_at) VALUES ('env:GC_TEST', 'env', 'env:GC_TEST', datetime('now'))").run();
  db.prepare("INSERT INTO entity (id, kind, canonical, created_at) VALUES ('env:OLD_TOMB', 'env', 'env:OLD_TOMB', datetime('now'))").run();

  const nowIso = new Date().toISOString();
  const past40dIso = new Date(Date.now() - 40 * 86_400_000).toISOString();

  // Insert active claim
  db.prepare(`
    INSERT INTO claim (id, subject_id, predicate, object_json, tx_from, authority, confidence, author, state, trust)
    VALUES ('c_active_1', 'env:GC_TEST', 'read_by', '"active"', ?, 1, 1.0, 'test', 'active', 'canonical')
  `).run(nowIso);

  // Insert recent retracted claim (tombstone)
  db.prepare(`
    INSERT INTO claim (id, subject_id, predicate, object_json, tx_from, authority, confidence, author, state, trust)
    VALUES ('c_recent_retracted', 'env:GC_TEST', 'read_by', '"recent"', ?, 1, 1.0, 'test', 'retracted', 'retracted')
  `).run(nowIso);

  // Insert old retracted claim (tombstone from 40 days ago)
  db.prepare(`
    INSERT INTO claim (id, subject_id, predicate, object_json, tx_from, authority, confidence, author, state, trust)
    VALUES ('c_old_retracted', 'env:OLD_TOMB', 'read_by', '"old"', ?, 1, 1.0, 'test', 'retracted', 'retracted')
  `).run(past40dIso);

  // With default 30-day retention, only c_old_retracted should be candidate
  const candidates30 = tombstoneCandidates(db, { tombstoneTtlDays: 30 });
  assert.equal(candidates30.length, 1, 'Expected 1 tombstone candidate for 30d TTL');
  assert.equal(candidates30[0].id, 'c_old_retracted');

  // With 0-day retention, both retracted claims should be candidates
  const candidates0 = tombstoneCandidates(db, { tombstoneTtlDays: 0 });
  assert.equal(candidates0.length, 2, 'Expected 2 tombstone candidates for 0d TTL');

  console.log('[TEST] Checking cascade purging of tombstones...');
  // Attach dependent rows to c_old_retracted
  db.prepare("INSERT INTO session (id, started_at, last_seen_at) VALUES ('s1', datetime('now'), datetime('now'))").run();
  db.prepare("INSERT INTO claim_read (claim_id, session_id, ts) VALUES ('c_old_retracted', 's1', datetime('now'))").run();
  db.prepare("INSERT INTO evidence (claim_id, kind, ref, hash, verified_at, status) VALUES ('c_old_retracted', 'file', 'README.md', 'abc', datetime('now'), 'valid')").run();
  db.prepare("INSERT INTO memory_commit (id, tree_hash, message, author, ts, kind) VALUES ('mc1', 'tree1', 'commit1', 'test', datetime('now'), 'test')").run();
  db.prepare("INSERT INTO commit_entry (commit_id, claim_id, op) VALUES ('mc1', 'c_old_retracted', 'retract')").run();
  db.prepare("INSERT INTO redaction (claim_id, original_hash, actor, reason, ts) VALUES ('c_old_retracted', 'hash1', 'actor1', 'reason1', datetime('now'))").run();
  db.prepare("INSERT INTO attestation (claim_id, attestation_claim_id, verdict, actor, ts) VALUES ('c_old_retracted', 'att_1', 'agree', 'actor1', datetime('now'))").run();

  // Another claim that supersedes c_old_retracted
  db.prepare(`
    INSERT INTO claim (id, subject_id, predicate, object_json, tx_from, authority, confidence, author, state, trust, supersedes)
    VALUES ('c_dependent_1', 'env:GC_TEST', 'read_by', '"dependent"', ?, 1, 1.0, 'test', 'active', 'canonical', 'c_old_retracted')
  `).run(nowIso);

  const purgedCount = purgeTombstones(db, candidates30, 'lore:test-gc');
  assert.equal(purgedCount, 1, 'Should have purged 1 tombstone');

  // Assert rows deleted / unlinked
  const checkClaim = db.prepare('SELECT id FROM claim WHERE id = ?').get('c_old_retracted');
  assert.equal(checkClaim, undefined, 'Claim should be deleted');

  const checkRead = db.prepare('SELECT claim_id FROM claim_read WHERE claim_id = ?').get('c_old_retracted');
  assert.equal(checkRead, undefined, 'claim_read should be deleted');

  const checkEvidence = db.prepare('SELECT claim_id FROM evidence WHERE claim_id = ?').get('c_old_retracted');
  assert.equal(checkEvidence, undefined, 'evidence should be deleted');

  const checkCommitEntry = db.prepare('SELECT claim_id FROM commit_entry WHERE claim_id = ?').get('c_old_retracted');
  assert.equal(checkCommitEntry, undefined, 'commit_entry should be deleted');

  const checkRedaction = db.prepare('SELECT claim_id FROM redaction WHERE claim_id = ?').get('c_old_retracted');
  assert.equal(checkRedaction, undefined, 'redaction should be deleted');

  const checkAttestation = db.prepare('SELECT claim_id FROM attestation WHERE claim_id = ?').get('c_old_retracted');
  assert.equal(checkAttestation, undefined, 'attestation should be deleted');

  const depClaim = db.prepare('SELECT supersedes FROM claim WHERE id = ?').get('c_dependent_1');
  assert.equal(depClaim.supersedes, null, 'supersedes pointer should be cleared to null');

  // Check purge_audit
  const auditRow = db.prepare('SELECT * FROM purge_audit WHERE claim_id = ?').get('c_old_retracted');
  assert.ok(auditRow, 'purge_audit row must exist');
  assert.equal(auditRow.actor, 'lore:test-gc');

  console.log('[TEST] Checking database vacuum compaction...');
  // Insert bulk rows then delete them to generate freelist pages
  db.transaction(() => {
    for (let i = 0; i < 200; i++) {
      db.prepare(`
        INSERT INTO claim (id, subject_id, predicate, object_json, tx_from, authority, confidence, author, state, trust)
        VALUES (?, 'env:GC_TEST', 'read_by', ?, ?, 1, 1.0, 'test', 'active', 'canonical')
      `).run(`bulk_${i}`, JSON.stringify({ payload: 'x'.repeat(500) }), nowIso);
    }
  })();

  db.prepare("DELETE FROM claim WHERE id LIKE 'bulk_%'").run();

  const statsBefore = getDatabaseStorageStats(db);
  assert.ok(statsBefore.freelistPages > 0, `Expected freelist pages > 0, got ${statsBefore.freelistPages}`);

  const compactRes = compactDatabase(db);
  assert.ok(compactRes.reclaimedPages > 0, 'Should have reclaimed pages');
  assert.equal(compactRes.after.freelistPages, 0, 'After VACUUM freelistPages should be 0');

  db.close();
  console.log('[OK] All Task 1 unit assertions passed cleanly');

  console.log('[TEST] Checking CLI gcCommand integration...');
  const cliDir = mkdtempSync(join(tmpdir(), 'lore-gc-cli-'));
  try {
    const { initCommand } = await import('../dist/commands/init.js');
    const { gcCommand } = await import('../dist/commands/gc.js');
    initCommand({ root: cliDir, solo: true });

    process.env.LORE_ROOT = cliDir;
    const cliDb = openDb(cliDir);

    cliDb.prepare("INSERT INTO entity (id, kind, canonical, created_at) VALUES ('env:GC_TEST', 'env', 'env:GC_TEST', datetime('now'))").run();

    // Insert an old draft
    cliDb.prepare(`
      INSERT INTO claim (id, subject_id, predicate, object_json, tx_from, authority, confidence, author, state, trust)
      VALUES ('c_cli_draft', 'env:GC_TEST', 'read_by', '"draft"', ?, 1, 1.0, 'test', 'draft', 'candidate')
    `).run(past40dIso);

    // Insert an old tombstone
    cliDb.prepare(`
      INSERT INTO claim (id, subject_id, predicate, object_json, tx_from, authority, confidence, author, state, trust)
      VALUES ('c_cli_tomb', 'env:GC_TEST', 'read_by', '"tomb"', ?, 1, 1.0, 'test', 'retracted', 'retracted')
    `).run(past40dIso);
    cliDb.close();

    // Run dry run
    gcCommand({ root: cliDir, ttlDays: '30', purgeTombstones: true, tombstoneTtlDays: '30', dryRun: true });

    // Verify still in place
    const checkDb1 = openDb(cliDir);
    assert.equal(checkDb1.prepare('SELECT state FROM claim WHERE id = ?').get('c_cli_draft')?.state, 'draft');
    assert.ok(checkDb1.prepare('SELECT id FROM claim WHERE id = ?').get('c_cli_tomb'));
    checkDb1.close();

    // Run actual GC with purge and compaction
    gcCommand({ root: cliDir, ttlDays: '30', purgeTombstones: true, tombstoneTtlDays: '30', compact: true });

    const checkDb2 = openDb(cliDir);
    // Draft should now be retracted
    assert.equal(checkDb2.prepare('SELECT state FROM claim WHERE id = ?').get('c_cli_draft')?.state, 'retracted');
    // Tombstone should be purged permanently
    assert.equal(checkDb2.prepare('SELECT id FROM claim WHERE id = ?').get('c_cli_tomb'), undefined);
    // Purge audit should exist
    assert.ok(checkDb2.prepare('SELECT * FROM purge_audit WHERE claim_id = ?').get('c_cli_tomb'));
    checkDb2.close();
    console.log('[OK] CLI gcCommand integration passed cleanly');
  } finally {
    delete process.env.LORE_ROOT;
    rmSync(cliDir, { recursive: true, force: true });
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
