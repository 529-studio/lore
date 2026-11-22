#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDb } from '../dist/db.js';
import { createSyncAdapter } from '../dist/sync/adapter.js';
import { LitestreamNotFoundError } from '../dist/sync/litestream.js';
import { ensureConfig } from '../dist/config.js';
import { head, makeCommit, upsertClaim } from '../dist/model.js';

const workDir = mkdtempSync(path.join(tmpdir(), 'lore-test-sync-'));

try {
  const localRoot = path.join(workDir, 'local');
  mkdirSync(localRoot, { recursive: true });
  const localDb = createDb(localRoot);
  ensureConfig(localRoot);

  const adapter = await createSyncAdapter(localDb, localRoot, { replicaUrl: 's3://test' });

  // 1. Test push before any commits (empty tip)
  const pushEmpty = await adapter.push({ author: 'test-agent' });
  assert.equal(pushEmpty.walCheckpointed, true);
  assert.equal(pushEmpty.tip, null);
  assert.equal(typeof pushEmpty.actionId, 'number');

  const pushLog1 = localDb.prepare('SELECT * FROM agent_action_log WHERE id = ?').get(pushEmpty.actionId);
  assert.ok(pushLog1);
  assert.equal(pushLog1.action, 'SYNC_OUTGOING');
  assert.equal(pushLog1.agent_id, 'test-agent');
  assert.equal(pushLog1.table_name, 'memory_commit');
  assert.equal(pushLog1.row_id, null);
  console.log('[OK] Push with empty tip passed');

  // 2. Test push with commit tip
  const commitId = makeCommit(localDb, {
    ref: 'main',
    entries: [],
    message: 'initial commit',
    author: 'agent:local',
    kind: 'init',
  });
  assert.ok(commitId);
  assert.equal(head(localDb, 'main'), commitId);

  const pushWithCommit = await adapter.push({ author: 'test-agent-2' });
  assert.equal(pushWithCommit.walCheckpointed, true);
  assert.equal(pushWithCommit.tip, commitId);
  assert.equal(typeof pushWithCommit.actionId, 'number');

  const pushLog2 = localDb.prepare('SELECT * FROM agent_action_log WHERE id = ?').get(pushWithCommit.actionId);
  assert.ok(pushLog2);
  assert.equal(pushLog2.action, 'SYNC_OUTGOING');
  assert.equal(pushLog2.agent_id, 'test-agent-2');
  assert.equal(pushLog2.table_name, 'memory_commit');
  assert.equal(pushLog2.row_id, commitId);
  console.log('[OK] Push with commit tip passed');

  // 3. Test pull throws LitestreamNotFoundError when executable is missing
  const missingBinAdapter = await createSyncAdapter(localDb, localRoot, {
    replicaUrl: 's3://test',
    execPath: path.join(workDir, 'nonexistent-bin'),
  });
  await assert.rejects(async () => {
    await missingBinAdapter.pull();
  }, (err) => err instanceof LitestreamNotFoundError);
  console.log('[OK] Pull throws LitestreamNotFoundError when binary missing');

  // 4. Test pull with empty replica (restore produces 0-byte or fails)
  const emptyMockBin = path.join(workDir, 'mock-empty-litestream');
  writeFileSync(emptyMockBin, `#!/usr/bin/env bash\nexit 0\n`, 'utf8');
  chmodSync(emptyMockBin, 0o755);

  const emptyAdapter = await createSyncAdapter(localDb, localRoot, {
    replicaUrl: 's3://test',
    execPath: emptyMockBin,
  });
  const pullEmpty = await emptyAdapter.pull({ author: 'pull-agent' });
  assert.deepEqual(pullEmpty, { entities: 0, claims: 0, commits: 0, merge: 'up-to-date' });
  console.log('[OK] Pull with empty replica returns up-to-date');

  // 5. Test pull with mock litestream restoring valid remote changes
  const remoteRoot = path.join(workDir, 'remote');
  mkdirSync(remoteRoot, { recursive: true });
  const remoteDb = createDb(remoteRoot);
  ensureConfig(remoteRoot);

  const claim = upsertClaim(remoteDb, {
    subject: 'file:docs/architecture.md',
    predicate: 'enforces_invariant',
    object: 'replicated state machine',
    author: 'agent:remote',
    evidence: [{ kind: 'file', ref: 'docs/architecture.md', hash: 'sha256:abc' }],
  });
  const remoteTip = makeCommit(remoteDb, {
    ref: 'main',
    entries: [{ claim_id: claim.id, op: 'add' }],
    message: 'feat: add architecture claim',
    author: 'agent:remote',
    kind: 'normal',
  });
  assert.ok(remoteTip);
  remoteDb.close();

  const remoteDbPath = path.join(remoteRoot, '.lore', 'lore.db');
  const restoreMockBin = path.join(workDir, 'mock-restore-litestream');
  writeFileSync(
    restoreMockBin,
    `#!/usr/bin/env bash\nif [ "$1" = "restore" ]; then\n  cp "${remoteDbPath}" "$3"\n  exit 0\nfi\nexit 0\n`,
    'utf8',
  );
  chmodSync(restoreMockBin, 0o755);

  const restoreAdapter = await createSyncAdapter(localDb, localRoot, {
    replicaUrl: 's3://remote-vault/lore.db',
    execPath: restoreMockBin,
  });
  const pullResult = await restoreAdapter.pull({ author: 'test-pull-agent' });
  assert.ok(pullResult.entities >= 1);
  assert.ok(pullResult.claims >= 1);
  assert.ok(pullResult.commits >= 1);
  assert.ok(pullResult.merge === 'fast-forward' || pullResult.merge === 'three-way');
  console.log('Pull Result:', pullResult);

  const pullLog = localDb.prepare('SELECT * FROM agent_action_log WHERE action = ? ORDER BY id DESC').get('SYNC_INCOMING');
  assert.ok(pullLog);
  assert.equal(pullLog.agent_id, 'test-pull-agent');
  assert.equal(pullLog.table_name, 'memory_commit');
  assert.equal(pullLog.row_id, remoteTip);

  const payload = JSON.parse(pullLog.new_state);
  assert.equal(payload.entities, pullResult.entities);
  assert.equal(payload.claims, pullResult.claims);
  assert.equal(payload.commits, pullResult.commits);
  assert.equal(payload.merge, pullResult.merge);
  console.log('[OK] Pull with remote bundle import and action log passed');

  localDb.close();
  console.log('[OK] All sync tests passed cleanly');
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
