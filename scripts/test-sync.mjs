import { createDb } from '../dist/db.js';
import { createSyncAdapter } from '../dist/sync/adapter.js';
import fs from 'node:fs';

const root = './test-sync-dir';
if (fs.existsSync(root)) {
  fs.rmSync(root, { recursive: true, force: true });
}
fs.mkdirSync(root, { recursive: true });

const db = createDb(root);

const adapter = await createSyncAdapter(db, root, { replicaUrl: 's3://test' });

// Test push
const pushResult = await adapter.push({ author: 'test-agent' });
const pushLog = db.prepare('SELECT * FROM agent_action_log WHERE action = ?').get('SYNC_OUTGOING');
console.log('Push Log:', pushLog);
if (!pushLog) throw new Error('Failed push sync log');
if (!pushResult || typeof pushResult.walCheckpointed !== 'boolean' || typeof pushResult.actionId !== 'number') {
  throw new Error('Failed push result shape');
}
console.log('Push Result:', pushResult);

// Test pull
const pullResult = await adapter.pull({ author: 'test-agent' });
const pullLog = db.prepare('SELECT * FROM agent_action_log WHERE action = ?').get('SYNC_INCOMING');
console.log('Pull Log:', pullLog);
if (!pullLog) throw new Error('Failed pull sync log');
if (
  !pullResult ||
  typeof pullResult.entities !== 'number' ||
  typeof pullResult.claims !== 'number' ||
  typeof pullResult.commits !== 'number' ||
  typeof pullResult.merge !== 'string'
) {
  throw new Error('Failed pull result shape');
}
console.log('Pull Result:', pullResult);

console.log('[OK] Sync adapter verification successful');

db.close();
fs.rmSync(root, { recursive: true, force: true });
