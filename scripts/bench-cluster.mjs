#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import pc from 'picocolors';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');

/**
 * Builds an adjacency map representing the peering topology for a cluster.
 * Supported topologies: 'ring', 'line', 'star', 'mesh'.
 *
 * @param {'ring' | 'line' | 'star' | 'mesh'} type
 * @param {number} nodeCount
 * @returns {Map<number, number[]>}
 */
export function buildTopology(type, nodeCount) {
  if (typeof nodeCount !== 'number' || nodeCount < 2) {
    throw new Error(`nodeCount must be an integer >= 2, got ${nodeCount}`);
  }

  const topology = new Map();

  switch (type) {
    case 'ring': {
      for (let i = 0; i < nodeCount; i++) {
        const prev = (i - 1 + nodeCount) % nodeCount;
        const next = (i + 1) % nodeCount;
        const neighbors = nodeCount === 2 ? [next] : [prev, next];
        topology.set(i, neighbors);
      }
      break;
    }

    case 'line': {
      for (let i = 0; i < nodeCount; i++) {
        const neighbors = [];
        if (i > 0) neighbors.push(i - 1);
        if (i < nodeCount - 1) neighbors.push(i + 1);
        topology.set(i, neighbors);
      }
      break;
    }

    case 'star': {
      // Node 0 is the center hub
      const allSatellites = [];
      for (let i = 1; i < nodeCount; i++) {
        allSatellites.push(i);
        topology.set(i, [0]);
      }
      topology.set(0, allSatellites);
      break;
    }

    case 'mesh': {
      // Full mesh: all nodes connect to all other nodes
      for (let i = 0; i < nodeCount; i++) {
        const peers = [];
        for (let j = 0; j < nodeCount; j++) {
          if (i !== j) peers.push(j);
        }
        topology.set(i, peers);
      }
      break;
    }

    default:
      throw new Error(`Unsupported topology type: ${type}. Expected ring, line, star, or mesh.`);
  }

  return topology;
}

/**
 * Encapsulates an autonomous Lore node replica within an isolated directory workspace.
 */
export class ClusterNode {
  constructor(nodeId, rootDir) {
    this.nodeId = nodeId;
    this.rootDir = rootDir;
    this.dir = path.join(rootDir, `node-${nodeId}`);
    this.dbPath = path.join(this.dir, '.lore', 'lore.db');
  }

  runCli(args, env = {}) {
    const res = spawnSync(process.execPath, [CLI, ...args], {
      cwd: this.dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        LORE_TRUST_MODE: 'permissive',
        ...env,
      },
    });

    if (res.status !== 0) {
      throw new Error(
        `Node ${this.nodeId} command 'lore ${args.join(' ')}' failed (code ${res.status}):\n${res.stderr || res.stdout}`,
      );
    }

    return res.stdout;
  }

  async init(clusterRepoId = 'cluster-sim-repo') {
    mkdirSync(path.join(this.dir, 'src'), { recursive: true });
    writeFileSync(
      path.join(this.dir, 'package.json'),
      JSON.stringify({ name: `cluster-node-${this.nodeId}`, dependencies: {} }, null, 2),
      'utf8',
    );
    writeFileSync(
      path.join(this.dir, 'README.md'),
      `# Cluster Node ${this.nodeId}\nReplica fixture for distributed cluster gossip simulation.\n`,
      'utf8',
    );
    writeFileSync(
      path.join(this.dir, 'src', 'index.ts'),
      `export const nodeId = ${this.nodeId};\n`,
      'utf8',
    );

    this.runCli(['init', '--solo']);

    // Standardize repo_id across replicas so bundles belong to the same cluster repo
    const configPath = path.join(this.dir, '.lore', 'config.json');
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      config.repo_id = clusterRepoId;
      writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    }
  }

  async createClaims(round, count = 1) {
    const created = [];
    for (let k = 0; k < count; k++) {
      const subject = `sym:node-${this.nodeId}.ts#fn_r${round}_${k}`;
      const object = `cluster gossip node ${this.nodeId} round ${round} item ${k}`;
      this.runCli([
        'write',
        '--subject',
        subject,
        '--predicate',
        'enforces_invariant',
        '--object',
        object,
        '--kind',
        'file',
        '--ref',
        'README.md',
      ]);
      created.push(subject);
    }

    this.runCli(['promote']);
    return created;
  }

  async exportBundle(outPath) {
    this.runCli(['bundle', 'export', '--out', outPath]);
    const stat = statSync(outPath);
    return stat.size;
  }

  async importBundle(inPath) {
    const stdout = this.runCli(['bundle', 'import', inPath, '--force']);
    // Example stdout: "imported 3 claim row(s), 2 commit row(s), merge three-way"
    const claimsMatch = stdout.match(/imported\s+(\d+)\s+claim/);
    const commitsMatch = stdout.match(/(\d+)\s+commit/);
    const mergeMatch = stdout.match(/merge\s+([a-zA-Z0-9-]+)/);

    return {
      claims: claimsMatch ? parseInt(claimsMatch[1], 10) : 0,
      commits: commitsMatch ? parseInt(commitsMatch[1], 10) : 0,
      merge: mergeMatch ? mergeMatch[1] : 'unknown',
    };
  }

  getClaimStats() {
    if (!existsSync(this.dbPath)) {
      return { totalClaims: 0, claimIds: new Set() };
    }
    const db = new Database(this.dbPath, { readonly: true });
    try {
      const rows = db.prepare('SELECT id FROM claim').all();
      return {
        totalClaims: rows.length,
        claimIds: new Set(rows.map((r) => r.id)),
      };
    } finally {
      db.close();
    }
  }

  auditIntegrity() {
    if (!existsSync(this.dbPath)) {
      return { integrityOk: false, claimCount: 0 };
    }
    const db = new Database(this.dbPath, { readonly: true });
    try {
      const check = db.prepare('PRAGMA integrity_check').all();
      const integrityOk = check.length === 1 && check[0].integrity_check === 'ok';
      const claimCount = db.prepare('SELECT COUNT(*) as n FROM claim').get().n;
      return {
        integrityOk,
        claimCount,
      };
    } finally {
      db.close();
    }
  }
}

/**
 * Validates SQLite database integrity and data invariants across all cluster replica nodes.
 */
export function auditClusterInvariants(nodes, expectedClaimCount, expectedClaimIds) {
  for (const node of nodes) {
    const audit = node.auditIntegrity();
    if (!audit.integrityOk) {
      throw new Error(`Node ${node.nodeId}: PRAGMA integrity_check failed`);
    }
    if (audit.claimCount !== expectedClaimCount) {
      throw new Error(
        `Node ${node.nodeId}: claim count mismatch: expected ${expectedClaimCount}, found ${audit.claimCount}`,
      );
    }
    if (expectedClaimIds && expectedClaimIds.size > 0) {
      const stats = node.getClaimStats();
      for (const id of expectedClaimIds) {
        if (!stats.claimIds.has(id)) {
          throw new Error(`Node ${node.nodeId}: missing claim ${id}`);
        }
      }
    }
  }

  return {
    allIntegrityOk: true,
    verifiedNodes: nodes.length,
    claimCount: expectedClaimCount,
  };
}

/**
 * Executes a full multi-replica cluster gossip simulation across a specified topology.
 *
 * @param {object} [options]
 * @param {number} [options.nodeCount=5]
 * @param {'ring' | 'line' | 'star' | 'mesh'} [options.topology='ring']
 * @param {number} [options.mutationRounds=2]
 * @param {number} [options.claimsPerNode=1]
 * @param {number} [options.maxGossipRounds=10]
 * @param {string} [options.workDir]
 * @param {boolean} [options.cleanup=true]
 */
export async function runClusterSimulation(options = {}) {
  const nodeCount = options.nodeCount ?? 5;
  const topologyType = options.topology ?? 'ring';
  const mutationRounds = options.mutationRounds ?? 2;
  const claimsPerNode = options.claimsPerNode ?? 1;
  const maxGossipRounds = options.maxGossipRounds ?? 10;
  const cleanup = options.cleanup ?? true;

  const workDir = options.workDir ?? mkdtempSync(path.join(tmpdir(), 'lore-bench-cluster-'));
  const bundlesDir = path.join(workDir, 'bundles');
  mkdirSync(bundlesDir, { recursive: true });

  const nodes = [];
  try {
    for (let i = 0; i < nodeCount; i++) {
      const node = new ClusterNode(i, workDir);
      await node.init();
      nodes.push(node);
    }

    const topology = buildTopology(topologyType, nodeCount);
    const globalClaimIds = new Set();
    const roundsSummary = [];
    let totalBytesTransferred = 0;
    let totalMessagesExchanged = 0;
    let converged = false;
    let roundsToConvergence = 0;

    const simStart = performance.now();

    for (let r = 1; r <= maxGossipRounds; r++) {
      const roundStart = performance.now();
      let newClaimsThisRound = 0;

      // 1. Mutation Phase: Nodes generate local claims during active mutation rounds
      if (r <= mutationRounds) {
        for (const node of nodes) {
          const created = await node.createClaims(r, claimsPerNode);
          newClaimsThisRound += created.length;
        }

        for (const node of nodes) {
          const stats = node.getClaimStats();
          for (const id of stats.claimIds) {
            globalClaimIds.add(id);
          }
        }
      }

      // 2. Export Phase: Nodes export state bundles for the current round
      const bundlePaths = new Map();
      for (const node of nodes) {
        const bundleFile = path.join(bundlesDir, `node-${node.nodeId}-r${r}.lorebundle`);
        await node.exportBundle(bundleFile);
        bundlePaths.set(node.nodeId, bundleFile);
      }

      // 3. Gossip Exchange Phase: Nodes import bundles from connected peers
      // Different destination nodes run in parallel; per destination node, peer imports are sequential.
      await Promise.all(
        nodes.map(async (node) => {
          const peers = topology.get(node.nodeId) || [];
          for (const peerId of peers) {
            const peerBundle = bundlePaths.get(peerId);
            if (peerBundle && existsSync(peerBundle)) {
              await node.importBundle(peerBundle);
              totalBytesTransferred += statSync(peerBundle).size;
              totalMessagesExchanged += 1;
            }
          }
        }),
      );

      // 4. Convergence Check
      let fullyConvergedNodes = 0;
      for (const node of nodes) {
        const stats = node.getClaimStats();
        if (stats.totalClaims === globalClaimIds.size) {
          let hasAll = true;
          for (const id of globalClaimIds) {
            if (!stats.claimIds.has(id)) {
              hasAll = false;
              break;
            }
          }
          if (hasAll) fullyConvergedNodes++;
        }
      }

      const roundDurationMs = performance.now() - roundStart;
      roundsSummary.push({
        round: r,
        newClaims: newClaimsThisRound,
        convergedNodes: fullyConvergedNodes,
        totalNodes: nodeCount,
        durationMs: roundDurationMs,
      });

      if (fullyConvergedNodes === nodeCount) {
        converged = true;
        roundsToConvergence = r;
        break;
      }
    }

    const totalDurationMs = performance.now() - simStart;

    // 5. Invariant Audit across all nodes
    const audit = auditClusterInvariants(nodes, globalClaimIds.size, globalClaimIds);

    return {
      converged,
      roundsToConvergence,
      totalRounds: roundsSummary.length,
      totalClaims: globalClaimIds.size,
      totalBytesTransferred,
      totalMessagesExchanged,
      durationMs: totalDurationMs,
      roundsSummary,
      audit,
      nodeCount,
      topology: topologyType,
    };
  } finally {
    if (cleanup) {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        // ignore teardown cleanup failure
      }
    }
  }
}
