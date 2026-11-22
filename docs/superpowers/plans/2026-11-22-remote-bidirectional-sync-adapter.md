# Remote Bi-directional Sync Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a production-grade bi-directional remote sync adapter and synchronization workflow (`src/sync/adapter.ts`, `src/sync/litestream.ts`, `src/commands/sync.ts`, `src/mcp/server.ts`), enabling distributed agents across independent environments to pull remote changes, execute 3-way CRDT merge ladders, and flush/publish converged memory state without database file clobbering or connection locking.

**Architecture:**
1. Upgrade `SyncAdapter` in `src/sync/adapter.ts` with structured `pull()` and `push()` interfaces returning detailed synchronization and merge metrics.
2. Implement robust `LitestreamSyncAdapter` in `src/sync/litestream.ts`: `pull()` restores replica snapshots into an isolated temporary database in `tmpdir`, extracts bundles, and merges into the local database using `importBundle` and `mergeTip`; `push()` executes SQLite WAL checkpoints (`PRAGMA wal_checkpoint(TRUNCATE)`), logs outgoing audit actions in `agent_action_log`, and prepares WAL frames for streaming.
3. Expose CLI command `lore sync [--replica <url>] [--author <id>]` in `src/commands/sync.ts` and `src/cli.ts` executing pull-then-push convergence.
4. Add MCP tool `memory_sync` in `src/mcp/server.ts` for autonomous zero-touch memory synchronization.
5. Create comprehensive smoke test suite in `scripts/sync-adapter-smoke.mjs` verifying multi-node convergence, non-conflicting union, and cardinality-1 conflict resolution.

**Tech Stack:** TypeScript, SQLite (`better-sqlite3`, WAL mode), Node.js (`node:child_process`, `node:fs`, `node:os`, `node:path`), Commander CLI, Model Context Protocol (MCP) SDK.

**Spec:** Issue #146 (`https://github.com/529-studio/lore/issues/146`), `SPEC.md` §15, `docs/HANDOFF-s7.md`.

---

## Global Constraints

- Root cause, never convenient patch (AGENTS.md Rule 1).
- Passing unit tests are never sufficient: every claim verified with command outputs (AGENTS.md Rule 2).
- PR branch `feat/sync-bidirectional-adapter`, merge commits only (`gh pr merge --merge`), no squash or rebase (AGENTS.md Rule 4).
- English, no emoji anywhere in code, commits, logs, or chat replies. Use `[OK]`, `[WARN]`, `[ERR]` (AGENTS.md Rule 5).
- Always-loaded docs (`README.md`, `AGENTS.md`, `CONTRIBUTING.md`) stay under 16 KB each and 36 KB combined (AGENTS.md Rule 7).
- Living documentation: update `README.md`, `SPEC.md` §15, and `docs/team-mode.md` in the same PR (AGENTS.md Rule 8).
- Estimate: 4.0h, delivery window: sprint 8 day 1 (AGENTS.md Rule 9).

---

## Review Focus

1. **Temporary Database Lock & Lifecycle Isolation**: `pull()` must restore replica to a freshly allocated directory in `os.tmpdir()`, open and extract bundles, and completely close the scratch SQLite database before deleting temporary files to avoid `EBUSY` / `SQLITE_BUSY` errors across platforms.
2. **Non-destructive Ingestion**: Pulling from a replica must never clobber unpushed local drafts, candidate claims, or branch tips; facts merge via `importBundle` and `mergeTip` using Lore's 3-way merge rules.
3. **Cardinality-1 Conflict Safety**: When two agents make conflicting statements about a single-valued predicate (e.g. `declared_dependency`), the sync process must preserve both, record the conflict in `claim_conflict`, and set `trust = contested`.
4. **WAL Checkpoint Safety**: `push()` must execute `PRAGMA wal_checkpoint(TRUNCATE)` so uncommitted WAL frames are flushed cleanly and made available for Litestream streaming.
5. **Fail-Closed Binary Resolution**: If `litestream` is missing when syncing with a Litestream replica, throw `LitestreamNotFoundError` with actionable installation instructions rather than silently failing.

---

### Task 1: Core Sync Adapter & Result Types (`src/sync/adapter.ts`)

**Files:**
- Modify: `src/sync/adapter.ts`

**Interfaces:**
- `interface SyncPullResult`: `{ entities: number; claims: number; commits: number; merge: 'none' | 'up-to-date' | 'fast-forward' | 'three-way' }`
- `interface SyncPushResult`: `{ walCheckpointed: boolean; tip: string | null; actionId: number }`
- `interface SyncOptions`: `{ replicaUrl: string; execPath?: string; configPath?: string }`
- `interface SyncAdapter`:
  - `pull(opts?: { author?: string }): Promise<SyncPullResult>`
  - `push(opts?: { author?: string }): Promise<SyncPushResult>`
- `function createSyncAdapter(db: DB, root: string, opts: SyncOptions): Promise<SyncAdapter>`

- [ ] **Step 1: Write type definitions and export interfaces in `src/sync/adapter.ts`**
- [ ] **Step 2: Update existing `scripts/test-sync.mjs` to consume new result interfaces**
- [ ] **Step 3: Run `node scripts/test-sync.mjs` to check compilation**
- [ ] **Step 4: Commit adapter interfaces**

---

### Task 2: Litestream Bidirectional Adapter Implementation (`src/sync/litestream.ts`)

**Files:**
- Modify: `src/sync/litestream.ts`
- Modify: `scripts/test-sync.mjs`

**Interfaces:**
- `class LitestreamSyncAdapter implements SyncAdapter`
  - `pull(opts?: { author?: string }): Promise<SyncPullResult>`:
    - Verifies litestream binary.
    - Restores replica snapshot to temporary directory via `restoreFromReplica`.
    - Reads remote bundle via `buildBundle` from restored database.
    - Imports bundle via `importBundle` and merges tip via `mergeTip`.
    - Logs `SYNC_INCOMING` to `agent_action_log`.
    - Cleans up temporary database files.
  - `push(opts?: { author?: string }): Promise<SyncPushResult>`:
    - Runs `PRAGMA wal_checkpoint(TRUNCATE)`.
    - Reads local `head(db, 'main')`.
    - Logs `SYNC_OUTGOING` to `agent_action_log`.

- [ ] **Step 1: Implement `pull` and `push` in `LitestreamSyncAdapter`**
- [ ] **Step 2: Update `scripts/test-sync.mjs` to verify pull/push return structures**
- [ ] **Step 3: Run `npm run typecheck && node scripts/test-sync.mjs`**
- [ ] **Step 4: Commit `LitestreamSyncAdapter` implementation**

---

### Task 3: CLI Sync Command (`src/commands/sync.ts` & `src/cli.ts`)

**Files:**
- Create: `src/commands/sync.ts`
- Modify: `src/cli.ts`

**Interfaces:**
- `interface SyncCommandOptions`: `{ replica?: string; author?: string; config?: string }`
- `function syncCommand(opts: SyncCommandOptions): Promise<void>`:
  - Resolves active repository root and config.
  - Instantiates `SyncAdapter`.
  - Executes `pull()` phase and logs incoming stats.
  - Executes `push()` phase and logs outgoing stats.
  - Prints clean formatted output with `[OK]`, `[WARN]`, or `[ERR]`.

- [ ] **Step 1: Implement `src/commands/sync.ts`**
- [ ] **Step 2: Register `program.command('sync')` in `src/cli.ts`**
- [ ] **Step 3: Build project and verify `node dist/cli.js sync --help`**
- [ ] **Step 4: Commit CLI sync command**

---

### Task 4: MCP Tool `memory_sync` (`src/mcp/server.ts`)

**Files:**
- Modify: `src/mcp/server.ts`

**Interfaces:**
- Tool `memory_sync`:
  - Input schema: `{ replica_url: z.string().optional() }`
  - Handler: executes `createSyncAdapter`, runs `pull()` then `push()`, returns JSON summary.

- [ ] **Step 1: Add `memory_sync` tool definition to `src/mcp/server.ts`**
- [ ] **Step 2: Add smoke verification assertion to `scripts/mcp-smoke.mjs`**
- [ ] **Step 3: Run `npm run mcp:smoke`**
- [ ] **Step 4: Commit MCP tool addition**

---

### Task 5: End-to-End Smoke Test Suite (`scripts/sync-adapter-smoke.mjs`)

**Files:**
- Create: `scripts/sync-adapter-smoke.mjs`
- Modify: `package.json:scripts`
- Modify: `scripts/smoke.sh`

**Interfaces:**
- Tests multi-node convergence:
  - Setup: creates Repo A and Repo B in temporary workspaces.
  - Mocks litestream replication to a shared filesystem directory.
  - Repo A writes Fact 1 (`env:API_KEY` `read_by` `src/api.ts`) -> runs `lore sync`.
  - Repo B writes Fact 2 (`sym:lib.ts#auth` `enforces_invariant` `token validation`) -> runs `lore sync`.
  - Repo A runs `lore sync`.
  - Asserts both Fact 1 and Fact 2 are present and canonical in both repositories.
  - Conflict test: Repo A writes `pkg:demo` `declared_dependency` `1.0.0`; Repo B writes `pkg:demo` `declared_dependency` `2.0.0` -> runs `lore sync` -> asserts `claim_conflict` recorded and trust is `contested`.

- [ ] **Step 1: Create `scripts/sync-adapter-smoke.mjs`**
- [ ] **Step 2: Add `"smoke:sync": "node scripts/sync-adapter-smoke.mjs"` in `package.json`**
- [ ] **Step 3: Wire into `scripts/smoke.sh`**
- [ ] **Step 4: Run `npm run build && node scripts/sync-adapter-smoke.mjs` to verify passing**
- [ ] **Step 5: Commit smoke test suite**

---

### Task 6: Documentation & Verification (`README.md`, `SPEC.md`, `docs/team-mode.md`)

**Files:**
- Modify: `README.md`
- Modify: `SPEC.md:15. Deviation log`
- Modify: `docs/team-mode.md`

- [ ] **Step 1: Document `lore sync` and bi-directional replication adapter in `README.md`**
- [ ] **Step 2: Add deviation log entry in `SPEC.md` §15**
- [ ] **Step 3: Update `docs/team-mode.md` with multi-node sync workflow**
- [ ] **Step 4: Run full verification suite (`npm run build`, `npm run smoke`, `npm run check:public`, `npm run docs:lint`)**
- [ ] **Step 5: Commit documentation and create PR referencing `Close #146`**
