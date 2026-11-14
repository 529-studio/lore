# AGENTS.md — project rules

These rules apply to humans and AI agents alike. They exist because each one was paid for
somewhere else; skipping them costs more than following them.

## 1. Root cause, never the convenient patch

Do not ship a band-aid to make a test green. Find the mechanism, fix it there, and prove it with a
command. If the fix is in a shared helper, check every call site — a half-applied fix is worse than
none (see [docs/lessons/L04](docs/lessons/L04-path-escape-half-fix.md)).

## 2. Evidence before assertions

Passing unit tests are never sufficient. Every claim in a PR must be reproducible by a command in
the PR description: `npm run smoke`, `npm run mcp:smoke`, `npm run eval`, or a scenario you ran by
hand. "Should work" is not evidence.

## 3. Do not trust the test that grades itself

If a check can pass while the product fails, the check is the bug. Scenario checks are fail-fatal;
metrics measure the product through its real CLI, not a private shortcut.

## 4. Git flow

- Never push to `main`. Branch `feat/*`, `fix/*`, `docs/*`, `chore/*`, open a PR.
- PR description starts with `Close #<issue-number>`.
- Conventional commits: `feat(merge): …`, `fix(cli): …`, `docs: …`.
- One concern per PR.
- Always create a merge commit (`gh pr merge --merge`). Never squash merge (`--squash`) or rebase merge.

## 5. English, no emoji

Code, logs, CLI output, docs and commit messages are English. No emoji anywhere — use `[OK]`,
`[WARN]`, `[ERR]`.

## 6. Secrets

Never commit tokens, keys, absolute home paths, internal hostnames, or `.env` files. Configuration
comes from the environment; fallbacks are empty strings, never placeholder credentials.
`npm run check:public` must pass.

## 7. Context budget

Documents are read on every task, so their size is a recurring cost. Always-loaded docs (`README.md`,
`AGENTS.md`, `CONTRIBUTING.md`) stay under 16 KB each and 36 KB combined. On-demand docs stay under
25 KB. `npm run docs:lint` enforces it.

## 8. Living documentation

A PR that changes behaviour updates `README.md`, the affected `docs/`, and `SPEC.md` §15 (deviation
log) in the same PR. If you learn something expensive, add `docs/lessons/L<NN>-<slug>.md` and one row
to `docs/lessons/INDEX.md`.

## 9. Estimate before you start

State the estimate in the issue before coding (hours and delivery window). The estimate must cover
the sound implementation, not the shortcut.

## 10. One sprint per conversation

When a sprint closes, write `docs/HANDOFF-s<N>.md` and start a new conversation from it. Long
conversations lose context and start repeating mistakes.
