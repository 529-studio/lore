# Implementation Plan: Bi-Temporal Search Engine (Valid-Time & Transaction-Time)

Tracking Issue: [#123](https://github.com/529-studio/lore/issues/123)
Estimate: 3.5h, delivery window: sprint 6 day 1

## Overview
Lore currently models bi-temporal fields (`valid_from`, `valid_to`, `tx_from`), but its search engine conflates the two time dimensions into a single `--as-of` instant. This feature decouples valid-time (world time) and transaction-time (commit/record time) into a dedicated bi-temporal query engine in `src/canon/temporal.ts`, integrates it with `src/retrieval.ts`, adds CLI commands (`lore search --valid-at/--tx-at`, `lore timeline`) and MCP tool parameters, and validates everything through an end-to-end smoke test suite.

---

### Task 1: Core Bi-Temporal Subsystem (`src/canon/temporal.ts`)
- Define `BiTemporalQuery`, `TimelinePoint`, and `TimelineResult` interfaces.
- Implement `parseTemporalInstant()` parsing ISO timestamps or timestamps in ms.
- Implement `isInValidTime()` supporting point ($t_v$) and range ($[v_1, v_2]$) constraints.
- Implement `queryBiTemporal()` integrating `activeAtAsOf` (transaction time) and `isInValidTime` (valid time).
- Implement `reconstructTimeline()` tracing the full lineage of a fact key or entity across time.
- Export subsystem functions from `src/canon/index.ts`.

### Task 2: Retrieval Engine Integration (`src/retrieval.ts`)
- Update `SearchOptions` with `validAt?: string` and `txAt?: string`.
- Update `branchSnapshot()` to evaluate `activeAtAsOf(db, headTip, txInstant)` and `validAt(claim, validInstant)`.
- Ensure backward compatibility when only `asOf` is provided (sets both).

### Task 3: CLI & MCP Surface
- Update `src/commands/search.ts` and `src/cli.ts` to accept `--valid-at <iso>` and `--tx-at <iso>`.
- Create `src/commands/timeline.ts` and register `lore timeline <subject> [predicate]` in `src/cli.ts`.
- Update `src/mcp/server.ts` to expose `valid_at` and `tx_at` on `memory_search`.

### Task 4: Test Suite & Harness Integration (`scripts/temporal-smoke.mjs`)
- Write `scripts/temporal-smoke.mjs` verifying:
  - Fact supersession with explicit `valid_from` / `valid_to`
  - Decoupled queries: $t_x \ne t_v$
  - Timeline reconstruction across updates
  - CLI `lore search` with `--valid-at` and `--tx-at`
  - CLI `lore timeline` table rendering
  - MCP `memory_search` with temporal arguments
- Add `"temporal:smoke"` script to `package.json` and call it in `scripts/smoke.sh`.

### Task 5: Documentation & Verification
- Update `README.md` command reference and examples.
- Update `SPEC.md` deviation log §15.
- Run `npm run build`, `npm run temporal:smoke`, `npm run smoke`, `npm run check:public`, `npm run docs:lint`.
- Commit, push, and open PR with `Close #123`.
