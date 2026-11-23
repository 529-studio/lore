# S8 Handoff & Sprint 9 Horizon

**Document**: `docs/HANDOFF-s8.md`
**Date**: 2026-11-23
**Repository**: `529-studio/lore`
**Charter**: Transition ledger for a fresh conversation: branch state, merged deliverables, open work, settled decisions, pitfalls, and the next sprint's tasks.

---

## 1. Branch & Commit Status

- **Active branch**: `main`
- **Head commit**: `5e8eec6` (`Merge pull request #149 from 529-studio/feat/concurrency-soak-benchmark`)
- **Worktree**: clean
- **Merged in Sprint 8**:
  - PR #147 (`feat(sync): bi-directional remote sync adapter and convergence workflow`, Issue #146)
  - PR #149 (`feat(bench): concurrency soak benchmark with high-frequency agent workers`, Issue #148)

---

## 2. Merged Deliverables

| PR | Task | Subsystem | Delivered capability |
| :--- | :--- | :-------- | :------------------- |
| **#147** | S8-T1 (#146) | `sync`, `mcp`, `cli` | **Bi-directional Remote Sync Adapter**: Implemented `LitestreamSyncAdapter` with push/pull reconciliation, snapshot exports, `lore sync` command, and `memory_sync` MCP tool for multi-node agent state convergence. |
| **#149** | S8-T2 (#148) | `bench`, `eval`, `scripts` | **Concurrency Soak Benchmark**: Automated multi-agent soak harness (`scripts/bench-concurrency.mjs`) simulating parallel MCP agent sessions (writes, searches, commits, syncs) over SQLite WAL storage with sub-millisecond percentile metrics and post-run invariant audits. |

---

## 3. Open Issues & Backlog

- Zero open issues and zero open pull requests in `529-studio/lore`.
- All planned Sprint 8 remote sync and concurrency soak deliverables landed cleanly and passed CI.

---

## 4. Settled Architectural Decisions

- **Coprimed Worker Workload Strides**: In multi-agent concurrent environments, striding worker start offsets (`(workerId - 1) * 3`) coprime with cycle length prevents lockstep lock contention, allowing heterogeneous operations (reads, writes, commits, syncs) to naturally overlap and stress SQLite's WAL mode.
- **Escalated Process Lifecycle Management**: `BenchmarkClient` subprocess teardown escalates from `SIGTERM` to `SIGKILL` after 1,000ms while inspecting both `exitCode` and `signalCode` to prevent orphaned child processes holding SQLite lock handles.
- **In-Process Database Invariant Auditing**: Concurrency benchmarks verify raw SQLite database invariants (`PRAGMA integrity_check = ok`, zero lost writes, branch continuity, action audit log entries) before destroying temporary fixtures.
- **Non-Destructive Bidirectional Sync**: Multi-node replication relies on additive convergence and local audit logging (`agent_action_log`) rather than destructive state replacement.

---

## 5. Pitfalls Encountered

- **Child Process `signalCode` Blindspot**: When a Node.js child process terminates via an OS signal (`SIGTERM`, `SIGKILL`, or OOM), `child.exitCode` remains `null` while `child.signalCode` is populated. Checking only `child.exitCode !== null` caused teardown timeouts waiting on an `'exit'` event that had already fired. **Prevention**: Always evaluate `child.exitCode !== null || child.signalCode !== null`.
- **Stream Pumping Garbage Collection**: Repeatedly re-concatenating intermediate buffers inside stream line extraction loops created unnecessary memory allocations under high-frequency soak testing. **Prevention**: Retain remaining unparsed bytes once outside the iteration loop.
- **Documentation Byte Budget Ceiling**: `README.md` is strictly limited to 16 KB (16,384 bytes) and enforced by `scripts/docs-lint.mjs`. Documenting new CLI flags and npm scripts requires tightening existing prose to prevent CI failures.

---

## 6. Sprint 9 Horizon: next tasks

1. Distributed multi-replica gossip topology simulator — `scripts/bench-cluster.mjs`
2. SQLite WAL automatic checkpoint threshold auto-tuning — `src/db.ts`
3. Natural language relative temporal query parsing — `src/canon/temporal.ts`
4. Memory garbage collection compaction policy and tombstone purging — `src/commands/gc.ts`
5. High-resolution benchmark dashboard exporter (Prometheus/OpenTelemetry) — `scripts/bench-concurrency.mjs`
6. Web UI real-time multi-agent sync indicators — `src/ui/server.ts`

---

## 7. Open Questions For The Human

- **Sync Architecture Expansion**: For Sprint 9, should we prioritize distributed cluster simulation (multi-replica gossip mesh) or auto-tuning database WAL checkpoints for single-node multi-agent workloads?
