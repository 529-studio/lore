# L10 — The sync merge bypassed the resolution ledger

## What happened

`lore resolve --take ours` recorded its decision in the `resolution` table, and `lore merge` and
`lore promote` both read that table. `mergeTip` in `src/sync.ts` — the merge that runs inside every
`lore push` and `lore fetch` — passed `pendingResolution: new Map()` instead. On a diverged remote,
the sync ladder produced the same conflict again, aborted, and no command could record the answer
the sync was actually looking for. `lore resolve` appeared to work (the row was written) and did
nothing for the failing path.

A second half of the same bug: when `mergeTip` aborted it threw before the caller could persist
`refs/remotes/origin/main`, so the store had no record of what the remote looked like, and the
conflicts were never written to `merge_conflict` either.

## Why it was expensive

The resolution looked applied because the command succeeded, and every later merge kept failing at
the same conflict. Only reading `src/sync.ts` next to `src/commands/merge.ts` showed two independent
`loadPending` implementations — one shared by the merge paths, one not called at all.

## Guardrail

There is one resolution loader (`src/resolution.ts#loadPending`) and one way to mark decisions
consumed (`markResolutionsApplied`). Every merge that can collide with a peer must pass it: merge,
promote, push, fetch, promote-proposal. And a sync merge records its own conflicts and the remote
tracking ref *before* it throws, so the failure is actionable from the store.

`scripts/hub-smoke.mjs` keeps a diverged two-client scenario: the second push must fail naming the
subject and predicate, `refs/remotes/origin/main` and an open `merge_conflict` row must exist,
`lore resolve --take ours` must be recorded, and the next push must advance main with a merge commit
that retracts the losing side.
