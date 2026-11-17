# Litestream SQLite Streaming Replication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a streaming SQLite WAL replication subsystem using Litestream (`src/sync/litestream.ts`), enabling continuous, real-time memory synchronization for distributed multi-agent workflows to cloud object storage (S3, Cloudflare R2) and local/NFS replicas.

**Architecture:**
1. Introduce `src/sync/litestream.ts` implementing binary detection, configuration compilation (`litestream.yml`), process spawning with graceful shutdown, database restore, and generation inspection.
2. Extend `src/config.ts` to support Litestream remote targets (`type: 'litestream'`, `replica_url`, `replica_type`).
3. Add CLI command `lore replicate <action>` in `src/commands/replicate.ts` registered in `src/cli.ts` (`check`, `config`, `start`, `restore`, `status`).
4. Add automated smoke tests in `scripts/litestream-smoke.mjs` verifying config formatting, binary discovery, error diagnostics, and mock replication lifecycle.

**Tech Stack:** TypeScript, Node.js (`child_process.spawn`, `node:fs`), Commander CLI, Picocolors, YAML.

---

## Global Constraints

- Root cause, never convenient patch (AGENTS.md Rule 1).
- Passing unit tests are never sufficient: every claim verified with command outputs (AGENTS.md Rule 2).
- Merge commits only (`gh pr merge --merge`), no squash or rebase merge (AGENTS.md Rule 4).
- English, no emoji anywhere in code, commits, logs, or chat replies. Use `[OK]`, `[WARN]`, `[ERR]` (AGENTS.md Rule 5).
- Always-loaded docs (`README.md`, `AGENTS.md`, `CONTRIBUTING.md`) must stay under 16 KB each and 36 KB combined (AGENTS.md Rule 7).
- Fail-closed error handling: if `litestream` is missing from system PATH, print actionable installation instructions rather than crashing silently.

---

### Task 1: Litestream Core Subsystem (`src/sync/litestream.ts` & `src/config.ts`)

**Files:**
- Create: `src/sync/litestream.ts`
- Modify: `src/config.ts:5-15`

**Interfaces:**
- `interface LitestreamOptions`: `replicaUrl: string`, `dbPath?: string`, `retention?: string`, `syncInterval?: string`
- `function findLitestreamBinary(): string | null`
- `function checkLitestreamInstalled(): { installed: boolean; binary: string | null; version?: string }`
- `function generateLitestreamConfig(root: string, opts: LitestreamOptions): string`
- `function writeLitestreamConfig(root: string, opts: LitestreamOptions): string`
- `function spawnLitestreamReplicate(root: string, opts?: { configPath?: string; replicaUrl?: string }): ChildProcess`
- `function restoreFromReplica(root: string, replicaUrl: string, opts?: { timestamp?: string; outputPath?: string }): Promise<void>`
- `function listReplicaGenerations(root: string, replicaUrl?: string): Promise<Array<{ generation: string; created: string }>>`

- [ ] **Step 1: Extend `src/config.ts` with Litestream remote type**
- [ ] **Step 2: Implement `src/sync/litestream.ts`**
- [ ] **Step 3: Export subsystem from `src/sync.ts` or standalone**
- [ ] **Step 4: Build project with `npm run build`**
- [ ] **Step 5: Commit core module**

---

### Task 2: CLI Command Integration (`src/commands/replicate.ts` & `src/cli.ts`)

**Files:**
- Create: `src/commands/replicate.ts`
- Modify: `src/cli.ts`

**Interfaces:**
- `replicateCommand(action: string, opts: ReplicateCommandOptions): Promise<void>`
  - `check`: Verify binary availability.
  - `config`: Generate and output/save `.lore/litestream.yml`.
  - `start`: Run continuous replication daemon.
  - `restore`: Restore `.lore/lore.db` from replica.
  - `status`: Show replica generations and status.

- [ ] **Step 1: Implement `src/commands/replicate.ts`**
- [ ] **Step 2: Register `lore replicate` command in `src/cli.ts`**
- [ ] **Step 3: Build project and verify CLI help output**
- [ ] **Step 4: Commit CLI command integration**

---

### Task 3: Smoke Test Suite (`scripts/litestream-smoke.mjs`)

**Files:**
- Create: `scripts/litestream-smoke.mjs`
- Modify: `package.json:scripts`

- [ ] **Step 1: Create `scripts/litestream-smoke.mjs` testing config generation, binary detection, and mock runner**
- [ ] **Step 2: Add `"smoke:litestream": "node scripts/litestream-smoke.mjs"` to `package.json`**
- [ ] **Step 3: Run smoke test and confirm passing**
- [ ] **Step 4: Commit smoke test**

---

### Task 4: Documentation & Verification

**Files:**
- Modify: `README.md`
- Modify: `SPEC.md:440-457`
- Modify: `docs/team-mode.md`

- [ ] **Step 1: Document streaming replication in `README.md`, `SPEC.md`, and `docs/team-mode.md`**
- [ ] **Step 2: Run all checks (`npm run build`, `npm run smoke`, `npm run check:public`, `npm run docs:lint`)**
- [ ] **Step 3: Commit docs, push branch, and create Pull Request**
