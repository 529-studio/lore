# Audit fixes — wave 2.5

Independent audit on `f3baa1a` found 4 blockers. Reproduced by the coordinator:

| Finding | Evidence |
|---|---|
| Drafts are live | `write.ts:42` commits every inserted claim, including drafts; retrieval/merge never filter `state` |
| Eval self-validates | `eval-results.json` records `draftGate: "FAIL — not gated"` and `conflictSetup: "FAIL"` while `failed: []` and verdict PASS |
| Cardinality-many collapsed | `merge.ts:50` `byKey` returns one claim per `(subject, predicate)`; retrieval uses it |
| Main never advances | only `init.ts` writes `ref main`; every later command writes `agent/<session>`, so a new session starts from the empty root |

Additional majors: merge ladder order (R3 evaluated after R5), no R4, single-parent commits (not a real DAG), global `claim.state` for approve/resolve, `hashFile` path escape, 48-bit ids, no transactions.

## Non-negotiable outcomes for wave 2.5

1. **Drafts never enter retrieval or merge.** `activeSet(branch)` includes only claims whose state is `active`. `write` does not create a commit entry for a draft. `approve` creates the entry on the approving branch.
2. **Branch bootstrap.** Any first commit on a new branch has `main`'s tip as parent. Add `lore promote` (fast-forward/merge current branch into `main`) so other sessions can inherit memory. `write`/`ingest` must add a commit entry for a claim that exists globally but is absent from the current branch active set.
3. **Cardinality-aware keys.** New contract:
   ```ts
   byKey(claims: ClaimRow[], cardinality: (predicate: string) => 'one' | 'many'): Map<string, ClaimRow[]>
   ```
   `one` → exactly one winner (supersede-aware, newest). `many` → every non-superseded value. Retrieval and merge must both use it.
4. **Merge ladder order is R2 → R3 → R4 → R5 → R6.** Implement R4 (retract vs edit: retract wins unless the retract side is stale). Equal `tx_from` must abort, not pick ours.
5. **Real DAG.** Commits get a second parent on merge (`merge_parent_id`), and LCA walks both parents. A claim retracted on one side after a merge must be visible to the next merge.
6. **Integrity.** Wrap claim+commit writes and merge application in `db.transaction`. `hashFile` must reject absolute paths, `..` traversal, non-regular files, and files above a size cap. Claim/commit ids use 128 bits (32 hex). `tree_hash` includes claim id + op/state.
7. **Eval must fail when the product fails.** Internal scenario checks (`draftGate`, `conflictSetup`) are fatal. Parse real ids (`c_`/`k_`). Measure `token_savings` through `lore search`, not a private SQL reconstruction. Pre-register the drift file set including docs. No synthetic clean merges in the conflict denominator.

## Definition of done

- `npm run build`, `npm run smoke`, `npm run mcp:smoke`, `npm run eval` all pass **with no recorded FAIL**.
- `scripts/smoke.sh` asserts: a draft is invisible to `search` before approve and visible after; a second session sees `main` after `lore promote`; a `many` predicate keeps ≥2 values through merge and search; R4 delete-vs-edit resolves; merge after merge keeps a retraction.
- Final report lists each numbered outcome above as DONE/PARTIAL with the assertion that proves it.

## Out of scope for this wave

MCP protocol work (M4), docs, `--strategy recency` semantics beyond current, UI.
