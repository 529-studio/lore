import { createDb } from '../src/db.js';
import { queryAsOf } from '../src/canon/temporal.js';
import fs from 'node:fs';

const root = './test-temporal-dir';
if (fs.existsSync(root)) {
  fs.rmSync(root, { recursive: true, force: true });
}
fs.mkdirSync(root);

const db = createDb(root);
db.prepare('INSERT OR REPLACE INTO session_context (id, agent_id) VALUES (1, ?)').run('test-agent');

// Helper to create a claim
function createClaim(id, subject, predicate, author, tx) {
    db.prepare('INSERT OR IGNORE INTO entity (id, kind, canonical, created_at) VALUES (?, ?, ?, ?)')
      .run(subject, 'test', 'canon', tx);
    
    db.prepare('INSERT INTO claim (id, subject_id, predicate, object_json, tx_from, authority, confidence, author, state, trust) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, subject, predicate, '{}', tx, 4, 1.0, author, 'active', 'canonical');
      
    // Manually set trust to canonical for the test
    db.prepare("UPDATE claim SET trust = 'canonical' WHERE id = ?").run(id);
    
    // Also add to memory_commit to ensure it's picked up by head tip
    const commitId = 'commit-' + id;
    db.prepare('INSERT OR REPLACE INTO memory_commit (id, tree_hash, message, author, ts, kind) VALUES (?, ?, ?, ?, ?, ?)').run(commitId, 'hash', 'message', 'author', tx, 'test');
    db.prepare('INSERT OR REPLACE INTO commit_entry (commit_id, claim_id, op) VALUES (?, ?, ?)').run(commitId, id, 'add');
    db.prepare('INSERT OR REPLACE INTO ref (name, commit_id) VALUES (?, ?)').run('main', commitId);
}

// 1. Create initial claim at T1
const T1 = '2026-01-01T10:00:00.000Z';
createClaim('c1', 'ent1', 'p', 'agent1', T1);

// 2. Supersede claim at T2
const T2 = '2026-01-01T12:00:00.000Z';
// Mark c1 as superseded
db.prepare("UPDATE claim SET state = 'retracted' WHERE id = ?").run('c1');
createClaim('c2', 'ent1', 'p', 'agent1', T2);
db.prepare("UPDATE claim SET supersedes = 'c1' WHERE id = ?").run('c2');

// 3. Verify as-of T1
const resT1 = queryAsOf(db, root, T1);
console.log('As-of T1:', resT1.map(r => r.id));
if (resT1.length !== 1 || resT1[0].id !== 'c1') {
    throw new Error('Failed T1 check');
}

// 4. Verify as-of T2
const resT2 = queryAsOf(db, root, T2);
console.log('As-of T2:', resT2.map(r => r.id));
if (resT2.length !== 1 || resT2[0].id !== 'c2') {
    throw new Error('Failed T2 check');
}

console.log('✓ Temporal query verification successful');

db.close();
fs.rmSync(root, { recursive: true, force: true });
