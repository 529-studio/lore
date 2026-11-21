import { createDb } from '../src/db.js';
import { createSyncAdapter } from '../src/sync/adapter.js';
import fs from 'node:fs';

const root = './test-sync-dir';
if (fs.existsSync(root)) {
  fs.rmSync(root, { recursive: true, force: true });
}
fs.mkdirSync(root);

const db = createDb(root);
db.prepare('INSERT OR REPLACE INTO session_context (id, agent_id) VALUES (1, ?)').run('test-agent');

const adapter = await createSyncAdapter(db, root, { replicaUrl: 's3://test' });

// Test push
await adapter.push();
const pushLog = db.prepare('SELECT * FROM agent_action_log WHERE action = ?').get('SYNC_OUTGOING');
console.log('Push Log:', pushLog);
if (!pushLog) throw new Error('Failed push sync log');

// Test pull
await adapter.pull();
const pullLog = db.prepare('SELECT * FROM agent_action_log WHERE action = ?').get('SYNC_INCOMING');
console.log('Pull Log:', pullLog);
if (!pullLog) throw new Error('Failed pull sync log');

console.log('✓ Sync adapter verification successful');

db.close();
fs.rmSync(root, { recursive: true, force: true });
