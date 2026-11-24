#!/usr/bin/env node
// Test suite for high-density graph clustering force-simulation and spatial quadtree index.
// Verifies simulation performance with 1,000+ nodes and O(log N) quadtree spatial queries.

import { GRAPH_WORKER_SCRIPT } from '../dist/ui/server.js';
import vm from 'node:vm';

let failures = 0;
function fail(msg) {
  console.error(`FAIL: ${msg}`);
  failures++;
}

function expect(cond, msg) {
  if (!cond) {
    fail(msg);
    return false;
  }
  return true;
}

console.log('[TEST] 1. Verify GRAPH_WORKER_SCRIPT JavaScript syntax via node:vm...');
try {
  new vm.Script(GRAPH_WORKER_SCRIPT);
  console.log('[OK] Worker script syntax is valid');
} catch (err) {
  fail(`worker script syntax error: ${err.message}`);
}

console.log('[TEST] 2. Run high-density force simulation (1,000 nodes, 1,500 links)...');
const width = 1200;
const height = 800;
const nodeTypes = ['file', 'env', 'pkg', 'doc', 'obj'];
const nodes = [];
for (let i = 0; i < 1000; i++) {
  nodes.push({
    id: `node:${i}`,
    type: nodeTypes[i % nodeTypes.length],
    degree: 0,
    x: 0,
    y: 0,
  });
}

const links = [];
for (let i = 0; i < 1500; i++) {
  const src = nodes[i % 1000];
  const tgt = nodes[(i * 3 + 7) % 1000];
  src.degree++;
  tgt.degree++;
  links.push({
    source: src.id,
    target: tgt.id,
    label: i % 2 === 0 ? 'imports_module' : 'read_by',
  });
}

// Execute simulation in sandbox context replicating Web Worker environment
let workerResult = null;
const workerContext = {
  Date,
  Math,
  Map,
  Array,
  self: {
    postMessage: (res) => {
      workerResult = res;
    },
  },
};
vm.createContext(workerContext);
vm.runInContext(GRAPH_WORKER_SCRIPT, workerContext);

const simStart = Date.now();
workerContext.self.onmessage({
  data: {
    type: 'simulate',
    nodes,
    links,
    width,
    height,
    clustered: true,
    iterations: 60,
  },
});
const totalElapsed = Date.now() - simStart;

expect(workerResult !== null, 'worker posted result back');
expect(workerResult?.type === 'complete', 'worker result type is complete');
expect(workerResult?.nodes?.length === 1000, `placed all 1,000 nodes (got ${workerResult?.nodes?.length})`);
expect(totalElapsed < 1000, `high-density layout finished in ${totalElapsed}ms (< 1000ms threshold)`);
console.log(`[OK] High-density force simulation finished in ${totalElapsed}ms (reported worker duration: ${workerResult?.durationMs}ms)`);

console.log('[TEST] 3. Spatial Quadtree Index integrity and point queries...');
const quadtree = workerResult?.quadtree;
expect(quadtree !== null && typeof quadtree === 'object', 'spatial quadtree index was generated');
expect(Array.isArray(quadtree.children), 'root quadtree node has children');

// Implement queryQuadtree matching UI client implementation
function queryQuadtree(qt, qx, qy, maxRadius) {
  if (!qt) return null;
  let closest = null;
  let closestDistSq = maxRadius * maxRadius;

  function search(node) {
    if (!node) return;
    if (
      qx < node.x0 - maxRadius ||
      qx > node.x1 + maxRadius ||
      qy < node.y0 - maxRadius ||
      qy > node.y1 + maxRadius
    ) {
      return;
    }
    if (node.points) {
      for (let i = 0; i < node.points.length; i++) {
        const p = node.points[i];
        const dx = p.x - qx;
        const dy = p.y - qy;
        const dSq = dx * dx + dy * dy;
        if (dSq < closestDistSq) {
          closestDistSq = dSq;
          closest = p;
        }
      }
      return;
    }
    if (node.children) {
      for (let i = 0; i < node.children.length; i++) {
        search(node.children[i]);
      }
    }
  }

  search(qt);
  return closest;
}

// Pick 5 random nodes from the result and query their coordinates
const placedNodes = workerResult.nodes;
for (let i = 0; i < 5; i++) {
  const target = placedNodes[Math.floor(Math.random() * placedNodes.length)];
  const hit = queryQuadtree(quadtree, target.x, target.y, 10);
  expect(hit !== null, `quadtree query found node near (${target.x.toFixed(1)}, ${target.y.toFixed(1)})`);
  expect(hit?.id === target.id, `quadtree query hit exact node ${target.id} (got ${hit?.id})`);
}

// Benchmark 1,000 random spatial queries
const queryStart = Date.now();
for (let i = 0; i < 1000; i++) {
  const qx = Math.random() * width;
  const qy = Math.random() * height;
  queryQuadtree(quadtree, qx, qy, 25);
}
const queryElapsed = Date.now() - queryStart;
expect(queryElapsed < 100, `1,000 quadtree hover queries completed in ${queryElapsed}ms (< 100ms)`);
console.log(`[OK] 1,000 spatial quadtree hover queries completed in ${queryElapsed}ms (${(queryElapsed / 1000).toFixed(3)}ms per query)`);

if (failures > 0) {
  console.error(`TEST FAILED with ${failures} error(s)`);
  process.exit(1);
}
console.log('[OK] All high-density graph worker and quadtree index tests passed cleanly!');
