# SQLite WAL Automatic Checkpoint Threshold Auto-Tuning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement adaptive SQLite WAL automatic checkpoint threshold auto-tuning and checkpoint utilities in `src/db.ts` to prevent WAL file bloat, eliminate writer starvation, and provide deterministic checkpoint observability across multi-agent workloads.

**Architecture:**
1. Extend `src/config.ts` with `WalConfig` (`autocheckpoint_pages`, `target_wal_size_kb`, `auto_tune`).
2. Implement core WAL inspection and checkpoint primitives in `src/db.ts`: `getWalStats`, `checkpointWal`, and `tuneWalCheckpoint`.
3. Wire `tuneWalCheckpoint` into `openDb` and `createDb` honoring environment (`$LORE_WAL_AUTOCHECKPOINT`), configuration (`.lore/config.json`), and adaptive page-size proportional scaling.
4. Build `scripts/test-wal-autotune.mjs` verifying metric accuracy, threshold customization, checkpoint modes (`PASSIVE`, `FULL`, `RESTART`, `TRUNCATE`), and WAL size recovery under high-frequency writes.
5. Update living documentation in `README.md` and `SPEC.md` §15.

**Tech Stack:** TypeScript, SQLite (`better-sqlite3`, WAL mode), Node.js `fs` / `path`.

**Spec:** Issue #153 (`https://github.com/529-studio/lore/issues/153`), `SPEC.md` §15, `docs/HANDOFF-s8.md`.

---

## Global Constraints

- Root cause, never convenient patch (AGENTS.md Rule 1).
- Passing unit tests are never sufficient: every claim verified with command outputs (AGENTS.md Rule 2).
- PR branch `feat/wal-autotune`, merge commits only (`gh pr merge --merge`), no squash or rebase (AGENTS.md Rule 4).
- English, no emoji anywhere in code, commits, logs, or chat replies. Use `[OK]`, `[WARN]`, `[ERR]` (AGENTS.md Rule 5).
- Always-loaded docs (`README.md`, `AGENTS.md`, `CONTRIBUTING.md`) stay under 16 KB each and 36 KB combined (AGENTS.md Rule 7).
- Living documentation: update `README.md` and `SPEC.md` §15 in the same PR (AGENTS.md Rule 8).
- Estimate: 2.5h, delivery window: sprint 9 day 1 (AGENTS.md Rule 9).

---

## Review Focus

1. **Non-Destructive Active Transaction Handling**: Ensure `checkpointWal` does not crash or throw when another thread or reader holds a read lock (`busy === true`), handling SQLite busy returns gracefully.
2. **Deterministic Threshold Hierarchy**: Verify that explicit function options override `$LORE_WAL_AUTOCHECKPOINT`, which overrides `.lore/config.json`, which overrides the adaptive default, with bounds checking ($N \ge 10$).
3. **Accurate Frame & File Math**: Ensure `getWalStats` calculates WAL frame log count and file sizes accurately on disk, returning 0 if the `-wal` file does not yet exist.
4. **Zero Overhead on Normal Open**: Ensure `openDb` and `createDb` apply PRAGMA `wal_autocheckpoint` during connection initialization without regressions to startup latency.
5. **Clean Type Checking & Strictness**: Exported TypeScript types (`WalCheckpointMode`, `WalCheckpointResult`, `WalStats`, `WalTuneOptions`, `WalTuneResult`) must compile strictly under `tsc --noEmit`.

---

### Task 1: Core WAL Primitives & Configuration (`src/config.ts`, `src/db.ts`)

**Files:**
- Modify: `src/config.ts`
- Modify: `src/db.ts`

**Interfaces:**
- `src/config.ts`:
  - `export interface WalConfig { autocheckpoint_pages?: number; target_wal_size_kb?: number; auto_tune?: boolean; }`
  - Add `wal?: WalConfig` to `LoreConfig`.
- `src/db.ts`:
  - `export type WalCheckpointMode = 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE';`
  - `export interface WalCheckpointResult { busy: boolean; log: number; checkpointed: number; }`
  - `export interface WalStats { pageSize: number; autocheckpointPages: number; walFrames: number; checkpointedFrames: number; walSizeBytes: number; dbSizeBytes: number; }`
  - `export function checkpointWal(db: DB, mode?: WalCheckpointMode): WalCheckpointResult`
  - `export function getWalStats(db: DB, root?: string): WalStats`

- [ ] **Step 1: Write failing unit test in `scripts/test-wal-autotune.mjs` verifying `getWalStats` and `checkpointWal`**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement `WalConfig` in `src/config.ts` and `checkpointWal` / `getWalStats` in `src/db.ts`**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit Task 1 primitives**

---

### Task 2: Adaptive Auto-Tuning Engine & Lifecycle Integration (`src/db.ts`)

**Files:**
- Modify: `src/db.ts`

**Interfaces:**
- `src/db.ts`:
  - `export interface WalTuneOptions { autocheckpointPages?: number; targetWalSizeKb?: number; }`
  - `export interface WalTuneResult { pageSize: number; configuredThreshold: number; activeThreshold: number; source: 'options' | 'env' | 'config' | 'adaptive' | 'default'; }`
  - `export function tuneWalCheckpoint(db: DB, root?: string, options?: WalTuneOptions): WalTuneResult`
  - Wire `tuneWalCheckpoint(db, root)` inside `openDb(root)` and `createDb(root)`.

- [ ] **Step 1: Add failing test in `scripts/test-wal-autotune.mjs` verifying hierarchy: env var, config file, options, and adaptive scaling**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement `tuneWalCheckpoint` and wire into `openDb` / `createDb`**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit Task 2 auto-tuning engine**

---

### Task 3: Load & Checkpoint Recovery Test Suite (`scripts/test-wal-autotune.mjs`)

**Files:**
- Modify: `scripts/test-wal-autotune.mjs`

**Interfaces:**
- Scenario assertions:
  - Generates 1,000 writes across a custom autocheckpoint threshold (e.g. 50 pages).
  - Verifies that `checkpointWal('TRUNCATE')` resets WAL size to 0 or baseline header.
  - Verifies that `openDb` automatically applies config and env thresholds.

- [ ] **Step 1: Add burst write test and TRUNCATE checkpoint verification to `scripts/test-wal-autotune.mjs`**
- [ ] **Step 2: Run test suite to verify all scenarios pass**
- [ ] **Step 3: Commit Task 3 test suite**

---

### Task 4: Documentation, Living Specs, and PR Verification (`README.md`, `SPEC.md`)

**Files:**
- Modify: `README.md`
- Modify: `SPEC.md:15. Deviation log`

- [ ] **Step 1: Document `LORE_WAL_AUTOCHECKPOINT` and `wal` configuration in `README.md`**
- [ ] **Step 2: Add deviation log entry in `SPEC.md` §15 for SQLite WAL checkpoint auto-tuning**
- [ ] **Step 3: Run full verification suite (`npm run build`, `npm run typecheck`, `npm run docs:lint`, `npm run check:public`, `node scripts/test-wal-autotune.mjs`, `npm run smoke`)**
- [ ] **Step 4: Commit documentation and create PR referencing `Close #153`**
