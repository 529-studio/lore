# Concurrency Soak Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement an automated concurrency soak benchmark harness (`scripts/bench-concurrency.mjs`) simulating high-frequency parallel autonomous agent workers under SQLite WAL mode, measuring throughput and latency percentiles (p50/p95/p99) across heterogeneous workloads, and verifying database integrity and DAG invariants under saturation.

**Architecture:**
1. Introduce `scripts/bench-concurrency.mjs` orchestrating N concurrent MCP worker subprocesses over stdio JSON-RPC against a unified repository fixture in `os.tmpdir()`.
2. Generate a realistic mixed workload per worker: 40% `memory_write`, 30% `memory_search`, 15% `memory_approve`/`memory_commit`, and 15% `memory_sync`.
3. Instrument high-resolution per-operation latency metrics via `node:perf_hooks` (`performance.now()`) to compute throughput (ops/sec), p50, p95, p99, and max latencies.
4. Execute automated post-benchmark SQLite database invariant audits (`PRAGMA integrity_check`, claim uniqueness, commit DAG continuity, and `agent_action_log` traceability).
5. Add CLI flag `--quick` for fast CI regression testing (<3s) alongside the full 1,000-operation soak run, and wire into `package.json` (`npm run bench:concurrency`).
6. Update living documentation in `README.md` and `SPEC.md` §15.

**Tech Stack:** Node.js (`node:child_process`, `node:perf_hooks`, `node:fs`, `node:os`, `node:path`), SQLite (`better-sqlite3`, WAL mode), JSON-RPC 2.0.

**Spec:** Issue #148 (`https://github.com/529-studio/lore/issues/148`), `SPEC.md` §15, `docs/HANDOFF-s7.md`.

---

## Global Constraints

- Root cause, never convenient patch (AGENTS.md Rule 1).
- Passing unit tests are never sufficient: every claim verified with command outputs (AGENTS.md Rule 2).
- PR branch `feat/concurrency-soak-benchmark`, merge commits only (`gh pr merge --merge`), no squash or rebase (AGENTS.md Rule 4).
- English, no emoji anywhere in code, commits, logs, or chat replies. Use `[OK]`, `[WARN]`, `[ERR]` (AGENTS.md Rule 5).
- Always-loaded docs (`README.md`, `AGENTS.md`, `CONTRIBUTING.md`) stay under 16 KB each and 36 KB combined (AGENTS.md Rule 7).
- Living documentation: update `README.md` and `SPEC.md` §15 in the same PR (AGENTS.md Rule 8).
- Estimate: 3.5h, delivery window: sprint 8 day 1 (AGENTS.md Rule 9).

---

## Review Focus

1. **Deadlock & Contention Prevention**: Ensure worker JSON-RPC timeouts and SQLite busy timeout (5000ms) prevent deadlocks when 8+ workers trigger concurrent commits, WAL checkpoints, and reads.
2. **Workload Realism**: The workload must not be purely writes; it must interleave writes, searches, approvals, commits, and syncs to stress mixed read/write concurrency.
3. **Accurate Percentile Calculations**: Latency measurements must use sorted sub-arrays and correct index interpolations for p50 (median), p95, and p99 without NaN or zero-division edge cases.
4. **Post-Run Integrity Verification**: Assert `PRAGMA integrity_check` returns `ok`, distinct claim count matches expected write operations, and no orphan DAG entries exist.
5. **Clean Resource Teardown**: All spawned worker processes must be terminated and scratch directories completely cleaned up in a `finally` block even on benchmark failure.

---

### Task 1: Core Benchmark Runner & Workload Generator (`scripts/bench-concurrency.mjs`)

**Files:**
- Create: `scripts/bench-concurrency.mjs`

**Interfaces:**
- `class BenchmarkClient`:
  - `constructor(session: string, cwd: string)`
  - `init(): Promise<void>`
  - `call(method: string, params?: unknown): Promise<unknown>`
  - `close(): void`
- Workload dispatcher:
  - Generates operation distributions: `write`, `search`, `approve`, `commit`, `sync`.
  - Records operation duration `durationMs: number`, `type: string`, `success: boolean`.

- [x] **Step 1: Create `scripts/bench-concurrency.mjs` with fixture setup and `BenchmarkClient`**
- [x] **Step 2: Implement heterogeneous workload loop executing across concurrent worker clients**
- [x] **Step 3: Run `node scripts/bench-concurrency.mjs` to verify basic execution**
- [x] **Step 4: Commit core benchmark runner**

---

### Task 2: Latency Distribution & SQLite Invariant Auditing (`scripts/bench-concurrency.mjs`)

**Files:**
- Modify: `scripts/bench-concurrency.mjs`

**Interfaces:**
- `function calculatePercentiles(latencies: number[]): { min: number; p50: number; p95: number; p99: number; max: number }`
- `function auditDatabaseInvariants(dbPath: string, expectedWrites: number, expectedWorkers: number): void`
  - Runs `PRAGMA integrity_check`.
  - Verifies `claim` counts, distinct IDs, and session branch refs.
  - Verifies `agent_action_log` contains `SYNC_OUTGOING` and `SYNC_INCOMING` records if sync operations executed.
- Formatted tabular output with picocolors and standard `[OK]` badges.

- [x] **Step 1: Implement percentile calculation math in `scripts/bench-concurrency.mjs`**
- [x] **Step 2: Implement database invariant audit function checking SQLite integrity and row counts**
- [x] **Step 3: Run benchmark and confirm metrics and invariant output display cleanly**
- [x] **Step 4: Commit latency and invariant auditing**

---

### Task 3: Package Wiring & Quick-Run Mode (`package.json`, `scripts/bench-concurrency.mjs`)

**Files:**
- Modify: `package.json:scripts`
- Modify: `scripts/bench-concurrency.mjs`

**Interfaces:**
- CLI flags and environment variables:
  - `--quick` or `LORE_SOAK_QUICK=1`: runs 4 workers x 25 operations (100 ops in <3s).
  - Default full soak: 8 workers x 125 operations (1,000 ops total).
  - Configurable via `LORE_SOAK_WORKERS` and `LORE_SOAK_OPS`.
- Script `"bench:concurrency": "node scripts/bench-concurrency.mjs"` in `package.json`.

- [x] **Step 1: Add `--quick` CLI argument parsing and environment variable overrides**
- [x] **Step 2: Add `"bench:concurrency": "node scripts/bench-concurrency.mjs"` to `package.json`**
- [x] **Step 3: Test `npm run bench:concurrency -- --quick` and full run**
- [x] **Step 4: Commit package wiring and quick mode**

---

### Task 4: Documentation & Verification (`README.md`, `SPEC.md`)

**Files:**
- Modify: `README.md`
- Modify: `SPEC.md:15. Deviation log`

- [x] **Step 1: Document `npm run bench:concurrency` in `README.md` under development/eval section**
- [x] **Step 2: Add deviation log entry in `SPEC.md` §15 for high-frequency concurrency soak testing**
- [x] **Step 3: Run full verification suite (`npm run build`, `npm run typecheck`, `npm run bench:concurrency -- --quick`, `npm run smoke`, `npm run docs:lint`, `npm run check:public`)**
- [x] **Step 4: Commit documentation and create PR referencing `Close #148`**
