# Distributed Multi-Replica Gossip Topology Simulator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement an automated distributed multi-replica gossip topology simulator (`scripts/bench-cluster.mjs`) modeling decentralized Lore nodes exchanging claims across configurable network topologies (ring, line, star, mesh), measuring convergence speed, round counts, message overhead, and verifying multi-node SQLite database integrity.

**Architecture:**
1. Build `scripts/bench-cluster.mjs` orchestrating N isolated replica node fixtures in temporary directories sharing a common repository namespace.
2. Implement topology graph generators (`ring`, `line`, `star`, `mesh`) specifying directed/bidirectional peering relationships.
3. Simulate iterative gossip rounds where nodes execute local claim commits and exchange bundles via Lore's bundle export/import and 3-way DAG merge machinery.
4. Measure round-by-round convergence latency, replication lag, transferred payload bytes, and total message counts.
5. Perform post-simulation database invariant audits asserting SQLite `PRAGMA integrity_check = ok`, zero lost writes, and exact global claim set equality across all replica nodes.
6. Integrate with `package.json` (`npm run bench:cluster`) with `--quick` mode support and document in `README.md` and `SPEC.md` §15.

**Tech Stack:** Node.js (`node:child_process`, `node:perf_hooks`, `node:fs`, `node:os`, `node:path`), SQLite (`better-sqlite3`, WAL mode), Picocolors.

**Spec:** Issue #151 (`https://github.com/529-studio/lore/issues/151`), `SPEC.md` §15, `docs/HANDOFF-s8.md`.

---

## Global Constraints

- Root cause, never convenient patch (AGENTS.md Rule 1).
- Passing unit tests are never sufficient: every claim verified with command outputs (AGENTS.md Rule 2).
- PR branch `feat/cluster-gossip-simulator`, merge commits only (`gh pr merge --merge`), no squash or rebase (AGENTS.md Rule 4).
- English, no emoji anywhere in code, commits, logs, or chat replies. Use `[OK]`, `[WARN]`, `[ERR]` (AGENTS.md Rule 5).
- Always-loaded docs (`README.md`, `AGENTS.md`, `CONTRIBUTING.md`) stay under 16 KB each and 36 KB combined (AGENTS.md Rule 7).
- Living documentation: update `README.md` and `SPEC.md` §15 in the same PR (AGENTS.md Rule 8).
- Estimate: 3.5h, delivery window: sprint 9 day 1 (AGENTS.md Rule 9).

---

## Review Focus

1. **Topology Graph Soundness**: Ensure generated adjacency matrices for `ring`, `line`, `star`, and `mesh` topologies are fully connected with no disconnected components or self-loops, preventing indefinite convergence stalls.
2. **Concurrent Bundle Import Merging**: Verify that importing multiple peer bundles within the same round applies Lore's 3-way DAG merge cleanly without lock collision, foreign key violations, or ref overwriting.
3. **Exact Convergence Parity**: Assert that convergence is only claimed when every node has verified identical claim counts AND identical claim ID sets matching the union of all generated claims.
4. **Clean Process and Fixture Teardown**: Ensure all subprocesses and temporary fixture directories across all cluster nodes are completely cleaned up in a `finally` block even when simulations abort or fail assertions.
5. **CI Execution Budget**: The `--quick` mode must finish in <3.0 seconds under CI constraints (3 nodes, ring topology, 1 mutation round, 3 claims total).

---

### Task 1: Topology Generators & Cluster Node Harness (`scripts/bench-cluster.mjs`)

**Files:**
- Create: `scripts/bench-cluster.mjs`

**Interfaces:**
- `export type TopologyType = 'ring' | 'line' | 'star' | 'mesh'`
- `export function buildTopology(type: TopologyType, nodeCount: number): Map<number, number[]>`
- `export class ClusterNode`:
  - `constructor(nodeId: number, rootDir: string)`
  - `init(): Promise<void>`
  - `createClaims(round: number, count: number): Promise<string[]>`
  - `exportBundle(outPath: string): Promise<number>` (returns bundle byte size)
  - `importBundle(inPath: string): Promise<{ claims: number; commits: number; merge: string }>`
  - `getClaimStats(): { totalClaims: number; claimIds: Set<string> }`
  - `auditIntegrity(): { integrityOk: boolean; claimCount: number }`

- [ ] **Step 1: Create `scripts/bench-cluster.mjs` with topology generator and test suite**
- [ ] **Step 2: Implement `ClusterNode` fixture setup and CLI invocation helpers**
- [ ] **Step 3: Run standalone topology test to verify adjacency connections across ring, line, star, and mesh**
- [ ] **Step 4: Commit Task 1 topology generator and node harness**

---

### Task 2: Multi-Round Gossip Simulator & Convergence Engine (`scripts/bench-cluster.mjs`)

**Files:**
- Modify: `scripts/bench-cluster.mjs`

**Interfaces:**
- `export async function runClusterSimulation(options?: ClusterOptions): Promise<ClusterResult>`
- Convergence loop:
  - Iterates through active mutation rounds where each node writes local claims.
  - Executes gossip rounds exchanging `.lorebundle` files between adjacent topology peers.
  - Measures per-round latency, total bytes exchanged, and cluster convergence ratio.
  - Continues propagation rounds until 100% of nodes share the global claim set or `maxRounds` is reached.

- [ ] **Step 1: Implement iterative gossip loop and convergence detection in `scripts/bench-cluster.mjs`**
- [ ] **Step 2: Add post-run database invariant auditing verifying SQLite integrity and claim equality across all nodes**
- [ ] **Step 3: Run `node scripts/bench-cluster.mjs --quick` and verify convergence and invariant output**
- [ ] **Step 4: Commit Task 2 gossip simulator engine**

---

### Task 3: Reporting, CLI Options, and Package Wiring (`package.json`, `scripts/bench-cluster.mjs`)

**Files:**
- Modify: `package.json:scripts`
- Modify: `scripts/bench-cluster.mjs`

**Interfaces:**
- CLI arguments & env vars:
  - `--quick` / `LORE_CLUSTER_QUICK=1`: 3 nodes, ring topology, 1 mutation round (<3s).
  - `--nodes <N>` / `LORE_CLUSTER_NODES`: number of cluster nodes (default 5).
  - `--topology <type>` / `LORE_CLUSTER_TOPOLOGY`: `ring` (default), `line`, `star`, `mesh`.
  - `--rounds <R>` / `LORE_CLUSTER_ROUNDS`: mutation rounds (default 2).
- Tabular reporting:
  - Box-drawing summary table with per-round convergence %, transferred bytes, and duration.
  - Per-node audit status with `[OK]` badges.
- `package.json`: `"bench:cluster": "node scripts/bench-cluster.mjs"`.

- [ ] **Step 1: Implement CLI argument parsing and box-drawing report table**
- [ ] **Step 2: Add `"bench:cluster": "node scripts/bench-cluster.mjs"` to `package.json`**
- [ ] **Step 3: Run `npm run bench:cluster -- --quick` and full simulation**
- [ ] **Step 4: Commit Task 3 CLI flags, report tables, and package wiring**

---

### Task 4: Documentation, Living Specs, and PR Verification (`README.md`, `SPEC.md`)

**Files:**
- Modify: `README.md`
- Modify: `SPEC.md:15. Deviation log`

- [ ] **Step 1: Document `npm run bench:cluster` in `README.md` with topologies and configuration flags**
- [ ] **Step 2: Add deviation log entry in `SPEC.md` §15 for distributed gossip topology simulation**
- [ ] **Step 3: Run full verification suite (`npm run build`, `npm run typecheck`, `npm run bench:cluster -- --quick`, `npm run bench:concurrency -- --quick`, `npm run smoke`, `npm run docs:lint`, `npm run check:public`)**
- [ ] **Step 4: Commit documentation and open PR referencing `Close #151`**
