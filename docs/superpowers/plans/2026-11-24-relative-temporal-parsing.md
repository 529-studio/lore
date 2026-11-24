# Natural Language Relative Temporal Query Parsing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement natural language relative temporal query parsing in `src/canon/temporal.ts` and unify with `src/retrieval.ts` so developers, CLI flags, and AI agents can query temporal memory using relative expressions (e.g. `"yesterday"`, `"3 days ago"`, `"-2h"`, `"last week"`).

**Architecture:**
1. Build `parseRelativeTemporal(value: string, now?: number): { timestamp: number; iso: string } | null` in `src/canon/temporal.ts` parsing keywords (`now`, `today`, `yesterday`, `tomorrow`, `last week`, `last month`, `last year`), verbose offsets (`<N> <unit>s ago`, `in <N> <unit>s`), and compact shorthands (`-3d`, `+2h`).
2. Upgrade `parseTemporalInstant(value, label, now?)` to evaluate relative expressions prior to ISO-8601 validation.
3. Unify `src/retrieval.ts` by replacing private `parseInstant` with `parseTemporalInstant`, bringing relative query capability to `lore search --as-of`, `--valid-at`, and `--tx-at`.
4. Validate with `scripts/test-temporal-relative.mjs` testing grammar parsing, unit math, timezone robustness, and bi-temporal CLI search.
5. Update `README.md` and `SPEC.md` §15 deviation log.

**Tech Stack:** TypeScript, Node.js.

**Spec:** Issue #155 (`https://github.com/529-studio/lore/issues/155`), `SPEC.md` §15, `docs/HANDOFF-s8.md`.

---

## Global Constraints

- Root cause, never convenient patch (AGENTS.md Rule 1).
- Passing unit tests are never sufficient: every claim verified with command outputs (AGENTS.md Rule 2).
- PR branch `feat/relative-temporal-parsing`, merge commits only (`gh pr merge --merge`), no squash or rebase (AGENTS.md Rule 4).
- Autonomous PR protocol: open PR, spawn reviewer agent, wait for CI, merge with merge commit (AGENTS.md Rule 4).
- English, no emoji anywhere in code, commits, logs, or chat replies. Use `[OK]`, `[WARN]`, `[ERR]` (AGENTS.md Rule 5).
- Always-loaded docs (`README.md`, `AGENTS.md`, `CONTRIBUTING.md`) stay under 16 KB each and 36 KB combined (AGENTS.md Rule 7).
- On-demand docs (`SPEC.md`) stay under 25 KB (25,600 bytes) (AGENTS.md Rule 7).
- Living documentation: update `README.md` and `SPEC.md` §15 in the same PR (AGENTS.md Rule 8).
- Estimate: 2.5h, delivery window: sprint 9 day 1 (AGENTS.md Rule 9).

---

## Review Focus

1. **Relative Date Arithmetic Precision**: Ensure months (30 days) and years (365 days) use deterministic millisecond math without floating-point drift or leap-second NaN anomalies.
2. **Case and Whitespace Tolerance**: The parser must handle case-insensitivity (`"Yesterday"`, `"3 DAYS AGO"`) and extraneous whitespace (`"  2   hours  ago  "`).
3. **Negative and Positive Shorthands**: Correctly differentiate past offsets (`-3d`, `3d ago`) from future offsets (`+2d`, `in 2d`), clamping timestamps cleanly to non-negative values.
4. **Backward Compatibility**: Any valid ISO-8601 timestamp string (`2026-11-20T12:00:00Z`, `2026-11-20`) must continue to parse identically to native `Date.parse`.
5. **Context Budget Enforcement**: Ensure modifications to `README.md` and `SPEC.md` remain strictly under the 16,384-byte and 25,600-byte ceilings.

---

### Task 1: Relative Temporal Grammar & Parsing Engine (`src/canon/temporal.ts`)

**Files:**
- Modify: `src/canon/temporal.ts`
- Test: `scripts/test-temporal-relative.mjs`

**Interfaces:**
- `src/canon/temporal.ts`:
  - `export interface RelativeTemporalResult { timestamp: number; iso: string; offsetMs: number; direction: 'past' | 'future' | 'now'; }`
  - `export function parseRelativeTemporal(value: string, now?: number): RelativeTemporalResult | null`
  - `export function parseTemporalInstant(value: string | number | undefined, label: string, now?: number): number`

- [ ] **Step 1: Write failing unit tests in `scripts/test-temporal-relative.mjs` covering keywords, verbose offsets, compact shorthands, and ISO fallbacks**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement `parseRelativeTemporal` and update `parseTemporalInstant` in `src/canon/temporal.ts`**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit Task 1 relative temporal parser**

---

### Task 2: Unify Retrieval & Bi-Temporal Search (`src/retrieval.ts`)

**Files:**
- Modify: `src/retrieval.ts`
- Modify: `scripts/test-temporal-relative.mjs`

**Interfaces:**
- `src/retrieval.ts`:
  - Replace private `parseInstant` with `parseTemporalInstant` from `./canon/temporal.js`.
  - Ensure `asOf`, `validAt`, and `txAt` resolve relative expressions in `branchSnapshot` and `searchMemory`.

- [ ] **Step 1: Add integration tests in `scripts/test-temporal-relative.mjs` verifying `searchMemory` with relative `asOf`, `validAt`, and `txAt`**
- [ ] **Step 2: Run test to verify it fails or needs retrieval wiring**
- [ ] **Step 3: Update `src/retrieval.ts` to use `parseTemporalInstant`**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit Task 2 retrieval unification**

---

### Task 3: Living Documentation & Autonomous PR Lifecycle (`README.md`, `SPEC.md`)

**Files:**
- Modify: `README.md`
- Modify: `SPEC.md:15. Deviation log`

- [ ] **Step 1: Document relative temporal query syntax in `README.md`**
- [ ] **Step 2: Add deviation log entry in `SPEC.md` §15 for natural language relative temporal queries**
- [ ] **Step 3: Run full verification suite (`npm run build`, `npm run typecheck`, `npm run docs:lint`, `npm run check:public`, `node scripts/test-temporal-relative.mjs`, `npm run smoke`)**
- [ ] **Step 4: Commit documentation, push branch, open PR referencing `Close #155`, spawn reviewer subagent, wait for CI, and merge via merge commit**
