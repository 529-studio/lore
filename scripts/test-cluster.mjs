#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildTopology, ClusterNode, runClusterSimulation } from './bench-cluster.mjs';

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

console.log('[TEST] Checking runClusterSimulation on ring topology...');
const simRing = await runClusterSimulation({
  nodeCount: 3,
  topology: 'ring',
  mutationRounds: 1,
  claimsPerNode: 1,
  maxGossipRounds: 5,
  cleanup: true,
});

assert.equal(simRing.converged, true);
assert.equal(simRing.totalClaims, 3);
assert.equal(simRing.nodeCount, 3);
assert.ok(simRing.roundsToConvergence >= 1);
assert.ok(simRing.totalBytesTransferred > 0);
assert.ok(simRing.totalMessagesExchanged > 0);
assert.equal(simRing.audit.allIntegrityOk, true);
assert.equal(simRing.audit.verifiedNodes, 3);
assert.equal(simRing.audit.claimCount, 3);
console.log(`[OK] Ring simulation converged in ${simRing.roundsToConvergence} rounds (${simRing.durationMs.toFixed(1)}ms)`);

console.log('[TEST] Checking runClusterSimulation on line topology...');
const simLine = await runClusterSimulation({
  nodeCount: 4,
  topology: 'line',
  mutationRounds: 1,
  claimsPerNode: 1,
  maxGossipRounds: 6,
  cleanup: true,
});

assert.equal(simLine.converged, true);
assert.equal(simLine.totalClaims, 4);
assert.equal(simLine.nodeCount, 4);
assert.ok(simLine.roundsToConvergence >= 2, `Line of 4 nodes should take >=2 rounds to converge across diameter 3, took ${simLine.roundsToConvergence}`);
assert.equal(simLine.audit.allIntegrityOk, true);
console.log(`[OK] Line simulation converged in ${simLine.roundsToConvergence} rounds (${simLine.durationMs.toFixed(1)}ms)`);

console.log('[OK] All cluster test assertions passed');
