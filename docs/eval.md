# Eval harness

The harness answers one question: **does memory make an agent better at this repository, and can we
prove it without asking another model to grade us?**

No LLM judge. Every number comes from running the CLI and reading the store.

```bash
npm run eval                    # generated sample fixture, 20 sessions
npm run eval -- --fixtures 1    # CI subset
LORE_EVAL_FIXTURES=/path/a,/path/b npm run eval   # your own repositories
LORE_EVAL_SESSIONS=5 npm run eval                 # shorter session replay
```

Results are printed and written to `eval-results.json` (gitignored).

## What it does per fixture

1. Copies the fixture to a temp directory. It never writes inside the source repository.
2. Runs the fixture's own test suite **before** anything else, so a broken baseline is visible.
3. `lore init`, `lore ingest`, and a second ingest to prove idempotency.
4. Writes an agent-inferred claim and proves it stays out of retrieval until approved.
5. Runs a deliberate conflict: two sessions, same `(subject, predicate)`, `--strict` merge must abort
   with exit 2, then resolve and re-merge.
6. Reverts the merge and compares the active set with the pre-merge snapshot.
7. Pre-registers a drift set from claim coverage (docs included), edits those files, checks that
   stale claims leave retrieval, then restores and re-checks.
8. Replays **20 distinct sessions**: each writes a claim and reads it back; wall time, invocations
   and a token proxy are recorded per session.
9. Runs the fixture suite again after the revert; `revert_correctness` means the suite passes.

## Metrics

| Metric | Definition | Threshold |
|---|---|---|
| `stale_rate` | claims whose evidence drifted, over active claims × drift files | < 15% |
| `false_claim_rate` | claims contradicted by manifest/source ground truth, over checked claims | < 5% |
| `conflict_rate` | aborts among merges that were expected to succeed | < 10% |
| `revert_correctness` | active set equals the pre-merge snapshot **and** the fixture suite passes | 100% |
| `token_savings` | tokens to answer 10 questions via `lore search` vs reading the referenced files | > 30% |
| `time_to_first_useful` | CLI invocations before a claim is read back | < 10 |

`token_savings` uses chars/4 as a token proxy and counts the JSON envelope the agent actually
receives. It is a lower bound, not a marketing number.

## Failure behaviour

Scenario checks are fail-fatal: a failed check adds to `failed[]`, prints the observed value, and the
process exits 1. The summary cannot print PASS while a scenario failed. This is deliberate — an
earlier version recorded `draftGate: FAIL` and still reported PASS (see
[lessons/L02](lessons/L02-eval-self-validation.md)).

## Limits

- Two proxies: tokens are chars/4, and `time_to_first_useful` counts invocations rather than minutes.
- The generated fixture is one repository shape. Point `LORE_EVAL_FIXTURES` at real repositories for
  a stronger signal; the numbers in the README come from the generated one so anyone can reproduce
  them.
- A fixture with no runnable test suite is reported as skipped with the reason, never silently
  counted as a pass.
