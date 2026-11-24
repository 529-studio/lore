# S9 Handoff & Sprint 10 Horizon

**Document**: `docs/HANDOFF-s9.md`  
**Date**: 2026-11-24  
**Repository**: `529-studio/lore`  
**Charter**: Transition ledger closing Sprint 9: branch state, merged deliverables, open work, settled decisions, pitfalls, and the next sprint's horizon.

---

## 1. Branch & Commit Status

- **Active branch**: `main`
- **Head commit**: `0f8d1db` (`Merge pull request #162 from 529-studio/feat/ui-sync-indicators`)
- **Worktree**: clean
- **Merged in Sprint 9**:
  - PR #152 (`feat(cluster): multi-replica gossip topology simulator`, Issue #151)
  - PR #154 (`feat(db): adaptive SQLite WAL checkpoint threshold auto-tuning`, Issue #153)
  - PR #156 (`feat(canon): natural language relative temporal query parsing`, Issue #155)
  - PR #158 (`feat(gc): memory garbage collection compaction policy and tombstone purging`, Issue #157)
  - PR #160 (`feat(bench): high-resolution benchmark dashboard exporter (Prometheus/OpenTelemetry)`, Issue #159)
  - PR #162 (`feat(ui): Web UI real-time multi-agent sync indicators`, Issue #161)

---

## 2. Merged Deliverables

| PR | Task | Subsystem | Delivered capability |
| :--- | :--- | :-------- | :------------------- |
| **#152** | S9-T1 (#151) | `cluster`, `sync`, `bench` | **Gossip Topology Simulator**: Multi-replica cluster gossip mesh simulator (`scripts/bench-cluster.mjs`) verifying convergence rounds, payload transfer overhead, and SQLite multi-node integrity. |
| **#154** | S9-T2 (#153) | `db`, `core` | **Adaptive WAL Auto-Tuning**: Dynamic SQLite WAL autocheckpoint scaling (`src/db.ts`), `tuneWalCheckpoint`, `checkpointWal`, `getWalStats`, and `LORE_WAL_AUTOCHECKPOINT` environment control. |
| **#156** | S9-T3 (#155) | `canon`, `retrieval` | **Relative Temporal Parsing**: Natural language temporal parsing in `src/canon/temporal.ts` supporting keywords, verbose offsets, and shorthands across `lore search --as-of`, `--valid-at`, and `--tx-at`. |
| **#158** | S9-T4 (#157) | `gc`, `cli` | **Compaction Policy & Tombstone Purging**: Retention-based tombstone purging, cascade deletion with `purge_audit` tracking, SQLite `VACUUM` compaction, and `--purge-tombstones`, `--compact` flags in `lore gc`. |
| **#160** | S9-T5 (#159) | `bench` | **Prometheus & OTel Exporters**: High-resolution metrics exporters in `scripts/bench-concurrency.mjs` outputting Prometheus exposition text and OpenTelemetry OTLP JSON metrics. |
| **#162** | S9-T6 (#161) | `ui` | **Real-Time Sync Indicators**: Live multi-agent sync indicator (`#sync-indicator`), `/api/sync/status` endpoint, active agent count pills, and SSE synchronization in the Web UI dashboard. |

---

## 3. Open Issues & Backlog

- Zero open issues and zero open pull requests in `529-studio/lore`.
- All 6 planned Sprint 9 Horizon tasks landed cleanly, verified with unit and regression suites, and passed CI checks.

---

## 4. Settled Architectural Decisions

- **Autonomous Task Completion Protocol**: Enforced in `AGENTS.md` §4: For every completed task, open a PR (`gh pr create`), spawn an automated reviewer subagent to check diff invariants, await CI passing, merge via merge commit (`gh pr merge --merge`), checkout `main` and pull.
- **Transactionless SQLite Compaction**: `VACUUM` must run strictly outside active SQLite transactions to avoid engine errors. All dependent row cascading and audit logging commit first, followed by vacuum execution.
- **Natural Temporal Resolution**: Relative expressions (`yesterday`, `-2h`, `last week`) resolve to exact millisecond timestamps relative to invocation instant or explicit anchor, unifying retrieval across CLI and MCP.
- **Standard Metrics Exposition**: Performance benchmarks export Prometheus text exposition format and OTLP JSON metrics directly to files without external dependencies.
- **DAG-Driven Convergence Indicators**: The Web UI uses local vs remote commit ancestor evaluation (`isAncestor`) to accurately indicate whether replicas are in sync, ahead, behind, or diverged.

---

## 5. Pitfalls Encountered

- **SQLite Audit Trigger Masking**: Triggers on `claim` table (e.g. `audit_claim_insert`) record `datetime('now')` into `agent_action_log`, which can mask historical creation times when computing candidate age. **Prevention**: Only evaluate `action = 'UPDATE'` in `agent_action_log` for retraction events, falling back to `claim.tx_from`.
- **Variable Shadowing in Test Scopes**: Re-declaring variables (`const pageHtml`) in inner test blocks created Temporal Dead Zone (TDZ) ReferenceErrors. **Prevention**: Use distinct variable names (`refreshedHtml`) for subsequent fetch calls.
- **Context Budget Ceilings**: Strict 16 KB per file limit on `README.md` and 25 KB limit on `SPEC.md`. Adding deviation rows requires continuous tightening of existing descriptions.

---

## 6. Sprint 10 Horizon: Next Tasks

1. Vector embeddings and semantic hybrid search layer — `src/search/vector.ts`
2. Cross-branch semantic three-way merge conflict resolver — `src/merge.ts`
3. MCP tool resource subscription protocol (`notifications/resources/updated`) — `src/mcp/server.ts`
4. Encrypted secret scrubbing and zero-knowledge claim attestations — `src/security/scrub.ts`
5. High-density graph clustering force-simulation web workers — `src/ui/server.ts`
6. Standalone cross-platform desktop binary packaging — `.github/workflows/desktop.yml`
