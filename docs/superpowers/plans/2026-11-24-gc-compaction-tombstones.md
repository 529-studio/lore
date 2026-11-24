# Plan: Memory Garbage Collection Compaction Policy and Tombstone Purging

**Issue**: [#157](https://github.com/529-studio/lore/issues/157)  
**Charter**: Implement memory garbage collection compaction policy and tombstone purging in `src/gc.ts`, `src/commands/gc.ts`, `src/cli.ts`, and `src/commands/status.ts`.

---

## Task 1: Tombstone Candidates, Purging, and Database Compaction Helpers in `src/gc.ts`

- Define interfaces `TombstoneCandidate`, `DatabaseStorageStats`, and `DatabaseCompactionResult`.
- Implement `tombstoneCandidates(db, options)` to identify retracted claims exceeding retention TTL.
- Implement `purgeTombstones(db, candidates, actor)` executing cascaded deletion with `purge_audit` records.
- Implement `getDatabaseStorageStats(db)` and `compactDatabase(db)` via SQLite page inspection and `VACUUM`.
- Create unit test in `scripts/test-gc-compaction.mjs` verifying candidate detection, foreign key cascades, audit records, and vacuum compaction.

## Task 2: CLI Wiring and Diagnostics in `src/commands/gc.ts`, `src/cli.ts`, and `src/commands/status.ts`

- Update `GcOptions` in `src/commands/gc.ts` with `purgeTombstones`, `tombstoneTtlDays`, and `compact`.
- Extend `gcCommand` to execute draft retractions, tombstone purging, hash-cache pruning, and optional `compactDatabase`.
- Wire `--purge-tombstones`, `--tombstone-ttl-days <n>`, and `--compact` options in `src/cli.ts`.
- Enhance `lore status` in `src/commands/status.ts` to surface retracted tombstone count and freelist reclaimable space.
- Add CLI integration assertions to `scripts/test-gc-compaction.mjs`.

## Task 3: Living Documentation & Autonomous PR Lifecycle

- Document new `lore gc` options in `README.md` within 16 KB context budget.
- Add deviation entry in `SPEC.md` §15 within 25 KB context budget.
- Run full verification suite: `npm run docs:lint && npm run build && npm run typecheck && npm run check:public && node scripts/test-gc-compaction.mjs && npm run smoke`.
- Mark SDD ledger complete.
- Execute autonomous PR lifecycle: push branch, `gh pr create`, spawn reviewer subagent, await CI checks, merge with `--merge`, checkout `main` and pull.
