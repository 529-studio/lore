import { createDb } from '../src/db.js';
import fs from 'node:fs';

const root = './test-audit-dir';
if (fs.existsSync(root)) {
  fs.rmSync(root, { recursive: true, force: true });
}
fs.mkdirSync(root);

const db = createDb(root);

// Insert an entity and claim
db.prepare('INSERT INTO entity (id, kind, canonical, created_at) VALUES (?, ?, ?, ?)').run('ent1', 'file', 'canon', new Date().toISOString());
db.prepare('INSERT INTO claim (id, subject_id, predicate, object_json, tx_from, authority, confidence, author) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('c1', 'ent1', 'p', '{}', new Date().toISOString(), 1, 0.9, 'test-agent');

// Verify log
const logs = db.prepare('SELECT * FROM agent_action_log').all();
console.log('Logs:', logs);

if (logs.length === 1 && logs[0].agent_id === 'test-agent') {
  console.log('✓ Audit log entry created with correct agent_id');
} else {
  console.error('✗ Audit log entry not created or incorrect agent_id');
  process.exit(1);
}

db.close();
fs.rmSync(root, { recursive: true, force: true });
