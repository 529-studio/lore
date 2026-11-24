#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
