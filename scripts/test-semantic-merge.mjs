#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  canonicalizeJsonValue,
  normalizeJsonPayload,
  isSemanticallyEquivalent,
  planMerge,
} from '../dist/merge.js';
import { createDb } from '../dist/db.js';
import { makeCommit, upsertClaim } from '../dist/model.js';
import { resolveCommand } from '../dist/commands/resolve.js';

console.log('[TEST] 1. JSON payload canonicalization & semantic equivalence...');
const jsonA = '{"port":8080, "host":"127.0.0.1", "tags":["b", "a"]}';
const jsonB = '{\n  "host": "127.0.0.1",\n  "port": 8080,\n  "tags": ["b", "a"]\n}';
const jsonC = '{"port":8081, "host":"127.0.0.1"}';

assert.equal(isSemanticallyEquivalent(jsonA, jsonB), true);
assert.equal(isSemanticallyEquivalent(jsonA, jsonC), false);
assert.equal(isSemanticallyEquivalent('plain text', 'plain text'), true);
assert.equal(isSemanticallyEquivalent('42', '42'), true);
console.log('[OK] JSON canonicalization passed');

console.log('[TEST] 2. Semantic equivalence in 3-way merge...');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-merge-test-'));
try {
  const db = createDb(tempDir);
  fs.mkdirSync(path.join(tempDir, '.lore'), { recursive: true });
  fs.writeFileSync(path.join(tempDir, '.lore', 'config.json'), JSON.stringify({}));
  fs.writeFileSync(
    path.join(tempDir, 'lore.ontology.yml'),
    'predicates:\n  server_config: { cardinality: one, domain: file }\n  dependency: { cardinality: one, domain: pkg }\n',
  );

  const ontology = {
    cardinality: (p) => (p === 'server_config' || p === 'dependency' ? 'one' : 'many'),
    domain: () => 'file',
    ttlDays: () => null,
  };

  db.prepare(`
    INSERT INTO entity (id, kind, canonical, created_at)
    VALUES
      ('file:config.json', 'file', 'file:config.json', datetime('now')),
      ('pkg:express', 'package', 'pkg:express', datetime('now')),
      ('file:src/auth.ts', 'file', 'file:src/auth.ts', datetime('now'))
  `).run();

  // Base commit
  const cBase = upsertClaim(db, {
    subject: 'file:config.json',
    predicate: 'server_config',
    object: '{"port": 3000, "debug": false}',
    evidence: [],
    author: 'agent:base',
    forceActive: true,
  });
  const baseTip = makeCommit(db, {
    ref: 'main',
    message: 'base commit',
    author: 'agent:base',
    kind: 'write',
    entries: [{ claim_id: cBase.id, op: 'add' }],
  });

  db.prepare("INSERT INTO ref (name, commit_id) VALUES ('branch_ours', ?), ('branch_theirs', ?)").run(
    baseTip,
    baseTip,
  );

  // Branch A: edits port to 8080
  const cOurs = upsertClaim(db, {
    subject: 'file:config.json',
    predicate: 'server_config',
    object: '{"port":8080,"debug":true}',
    supersedes: cBase.id,
    evidence: [],
    author: 'agent:ours',
    forceActive: true,
  });
  const oursTip = makeCommit(db, {
    ref: 'branch_ours',
    message: 'branch ours commit',
    author: 'agent:ours',
    kind: 'write',
    entries: [{ claim_id: cOurs.id, op: 'add' }],
  });

  // Branch B: edits port to 8080 with different key order / whitespace
  const cTheirs = upsertClaim(db, {
    subject: 'file:config.json',
    predicate: 'server_config',
    object: '{\n  "debug": true,\n  "port": 8080\n}',
    supersedes: cBase.id,
    evidence: [],
    author: 'agent:theirs',
    forceActive: true,
  });
  const theirsTip = makeCommit(db, {
    ref: 'branch_theirs',
    message: 'branch theirs commit',
    author: 'agent:theirs',
    kind: 'write',
    entries: [{ claim_id: cTheirs.id, op: 'add' }],
  });

  // Standard merge should recognize semantic equivalence without entering conflict!
  const planEquiv = planMerge(db, tempDir, oursTip, theirsTip, {
    strategy: 'authority',
    strict: false,
    ontology,
    pendingResolution: new Map(),
  });

  assert.equal(planEquiv.mode, 'three-way');
  assert.equal(planEquiv.conflicts.length, 0);
  assert.equal(planEquiv.decisions.length, 1);
  assert.equal(planEquiv.decisions[0].rule, 'semantic_identity');
  console.log('[OK] Semantic payload identity resolved cleanly');

  console.log('[TEST] 3. Semantic confidence tiebreak for equal-tier inference disagreements...');
  // Divergent claims on same tier T4 (inference)
  const cDepOurs = upsertClaim(db, {
    subject: 'pkg:express',
    predicate: 'dependency',
    object: '"^4.19.2"',
    evidence: [],
    confidence: 0.95,
    author: 'agent:ours',
    forceActive: true,
  });
  db.prepare('UPDATE claim SET authority = 4 WHERE id = ?').run(cDepOurs.id);

  const cDepTheirs = upsertClaim(db, {
    subject: 'pkg:express',
    predicate: 'dependency',
    object: '"^4.18.2"',
    evidence: [],
    confidence: 0.65,
    author: 'agent:theirs',
    forceActive: true,
  });
  db.prepare('UPDATE claim SET authority = 4 WHERE id = ?').run(cDepTheirs.id);

  const oursTip2 = makeCommit(db, {
    ref: 'branch_ours2',
    message: 'ours inference',
    author: 'agent:ours',
    kind: 'write',
    entries: [{ claim_id: cDepOurs.id, op: 'add' }],
  });

  const theirsTip2 = makeCommit(db, {
    ref: 'branch_theirs2',
    message: 'theirs inference',
    author: 'agent:theirs',
    kind: 'write',
    entries: [{ claim_id: cDepTheirs.id, op: 'add' }],
  });

  // Without semantic: aborts to conflict
  const planStandard = planMerge(db, tempDir, oursTip2, theirsTip2, {
    strategy: 'authority',
    strict: false,
    ontology,
    pendingResolution: new Map(),
  });
  assert.equal(planStandard.mode, 'conflict');
  assert.equal(planStandard.conflicts.length, 1);

  // With semantic: resolves by confidence
  const planSemantic = planMerge(db, tempDir, oursTip2, theirsTip2, {
    strategy: 'semantic',
    semantic: true,
    strict: false,
    ontology,
    pendingResolution: new Map(),
  });
  assert.equal(planSemantic.mode, 'three-way');
  assert.equal(planSemantic.conflicts.length, 0);
  assert.equal(planSemantic.decisions.length, 1);
  assert.equal(planSemantic.decisions[0].rule, 'semantic_confidence');
  assert.equal(planSemantic.decisions[0].winner, cDepOurs.id);
  console.log('[OK] Semantic confidence tiebreak passed');

  console.log('[TEST] 4. Semantic vector alignment tiebreak...');
  // Equal confidence (0.80), equal tier (T4)
  const cRouteOurs = upsertClaim(db, {
    subject: 'file:src/auth.ts',
    predicate: 'server_config',
    object: '"POST /api/auth/token OAuth bearer authentication endpoint"',
    evidence: [],
    confidence: 0.8,
    author: 'agent:ours',
    forceActive: true,
  });
  db.prepare('UPDATE claim SET authority = 4 WHERE id = ?').run(cRouteOurs.id);

  const cRouteTheirs = upsertClaim(db, {
    subject: 'file:src/auth.ts',
    predicate: 'server_config',
    object: '"chocolate strawberry cookie baking recipe"',
    evidence: [],
    confidence: 0.8,
    author: 'agent:theirs',
    forceActive: true,
  });
  db.prepare('UPDATE claim SET authority = 4 WHERE id = ?').run(cRouteTheirs.id);

  const oursTip3 = makeCommit(db, {
    ref: 'branch_ours3',
    message: 'ours alignment',
    author: 'agent:ours',
    kind: 'write',
    entries: [{ claim_id: cRouteOurs.id, op: 'add' }],
  });

  const theirsTip3 = makeCommit(db, {
    ref: 'branch_theirs3',
    message: 'theirs alignment',
    author: 'agent:theirs',
    kind: 'write',
    entries: [{ claim_id: cRouteTheirs.id, op: 'add' }],
  });

  const planAlign = planMerge(db, tempDir, oursTip3, theirsTip3, {
    strategy: 'semantic',
    semantic: true,
    strict: false,
    ontology,
    pendingResolution: new Map(),
  });
  assert.equal(planAlign.mode, 'three-way');
  assert.equal(planAlign.conflicts.length, 0);
  assert.equal(planAlign.decisions.length, 1);
  assert.equal(planAlign.decisions[0].rule, 'semantic_similarity');
  assert.equal(planAlign.decisions[0].winner, cRouteOurs.id);
  console.log('[OK] Semantic vector alignment tiebreak passed');

  console.log('[TEST] 5. Automated resolution via lore resolve --auto-semantic...');
  // Insert open merge conflict into table
  db.prepare(
    `INSERT INTO merge_conflict (ours_tip, theirs_tip, subject_id, predicate, ours_claim, theirs_claim, base_claim, reason, ts, resolved)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(
    oursTip2,
    theirsTip2,
    'pkg:express',
    'dependency',
    cDepOurs.id,
    cDepTheirs.id,
    null,
    'conflict test',
    new Date().toISOString(),
  );

  // Call resolveCommand with autoSemantic
  resolveCommand({ autoSemantic: true, root: tempDir });

  const resRow = db.prepare('SELECT * FROM resolution WHERE subject_id = ? AND predicate = ?').get(
    'pkg:express',
    'dependency',
  );
  assert.ok(resRow);
  assert.equal(resRow.take, 'ours');
  assert.ok(resRow.reason.includes('confidence'));
  console.log('[OK] Automated lore resolve --auto-semantic passed');

  db.close();
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('[OK] All semantic merge conflict resolver tests passed cleanly!');
