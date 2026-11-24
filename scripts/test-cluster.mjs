#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildTopology, ClusterNode } from './bench-cluster.mjs';

console.log('[TEST] Checking topology generator...');

// 1. Ring topology
const ring = buildTopology('ring', 4);
assert.equal(ring.size, 4);
assert.deepEqual(ring.get(0)?.sort(), [1, 3]);
assert.deepEqual(ring.get(1)?.sort(), [0, 2]);
assert.deepEqual(ring.get(2)?.sort(), [1, 3]);
assert.deepEqual(ring.get(3)?.sort(), [0, 2]);

// 2. Line topology
const line = buildTopology('line', 4);
assert.equal(line.size, 4);
assert.deepEqual(line.get(0)?.sort(), [1]);
assert.deepEqual(line.get(1)?.sort(), [0, 2]);
assert.deepEqual(line.get(2)?.sort(), [1, 3]);
assert.deepEqual(line.get(3)?.sort(), [2]);

// 3. Star topology
const star = buildTopology('star', 4);
assert.equal(star.size, 4);
assert.deepEqual(star.get(0)?.sort(), [1, 2, 3]);
assert.deepEqual(star.get(1)?.sort(), [0]);
assert.deepEqual(star.get(2)?.sort(), [0]);
assert.deepEqual(star.get(3)?.sort(), [0]);

// 4. Mesh topology
const mesh = buildTopology('mesh', 4);
assert.equal(mesh.size, 4);
assert.deepEqual(mesh.get(0)?.sort(), [1, 2, 3]);
assert.deepEqual(mesh.get(1)?.sort(), [0, 2, 3]);
assert.deepEqual(mesh.get(2)?.sort(), [0, 1, 3]);
assert.deepEqual(mesh.get(3)?.sort(), [0, 1, 2]);

console.log('[OK] Topology generator assertions passed');

console.log('[TEST] Checking ClusterNode lifecycle...');
const work = mkdtempSync(path.join(tmpdir(), 'lore-test-cluster-node-'));

try {
  const node0 = new ClusterNode(0, work);
  const node1 = new ClusterNode(1, work);

  await node0.init();
  await node1.init();

  const claims0 = await node0.createClaims(1, 2);
  assert.equal(claims0.length, 2);

  const stats0 = node0.getClaimStats();
  assert.equal(stats0.totalClaims, 2);

  const bundlePath = path.join(work, 'node0.lorebundle');
  const byteSize = await node0.exportBundle(bundlePath);
  assert.ok(byteSize > 0);
  assert.ok(existsSync(bundlePath));

  const importRes = await node1.importBundle(bundlePath);
  assert.equal(importRes.claims, 2);

  const stats1 = node1.getClaimStats();
  assert.equal(stats1.totalClaims, 2);
  assert.deepEqual(stats0.claimIds, stats1.claimIds);

  const audit0 = node0.auditIntegrity();
  assert.equal(audit0.integrityOk, true);
  assert.equal(audit0.claimCount, 2);

  const audit1 = node1.auditIntegrity();
  assert.equal(audit1.integrityOk, true);
  assert.equal(audit1.claimCount, 2);

  console.log('[OK] ClusterNode lifecycle assertions passed');
} finally {
  rmSync(work, { recursive: true, force: true });
}
