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

## 4. Git flow & Autonomous PR lifecycle

- Never push to `main`. Branch `feat/*`, `fix/*`, `docs/*`, `chore/*`, open a PR.
- PR description starts with `Close #<issue-number>`.
- Conventional commits: `feat(merge): …`, `fix(cli): …`, `docs: …`.
- One concern per PR.
- Always create a merge commit (`gh pr merge --merge`). Never squash merge (`--squash`) or rebase merge.
- Automated task completion protocol:
  1. Upon finishing a task and passing local verifications, push the branch and open a PR (`gh pr create`).
  2. Automatically spawn a reviewer subagent to review the PR diff against project invariants.
  3. Wait for all CI checks to pass (`gh pr checks`).
  4. Automatically merge the PR using a merge commit (`gh pr merge --merge`).
  5. Checkout `main` and pull latest changes before starting the next task.

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

<!-- lore:memory-protocol:start -->
## 11. Persistent memory protocol (Lore)

This project uses Lore for shared memory across all AI agents and sessions.

### Protocol Actions
- **Task start**: Before proposing or editing code, invoke MCP tool `memory_search` with relevant file paths, symbols, or feature keywords to retrieve active architectural decisions, conventions, and environment variables.
- **Definition of Done**: When introducing or modifying environment variables, API endpoints, module dependencies, or architectural rules, invoke `memory_write` with evidence.
- **Provenance & drift**: Use `memory_blame` to verify authority, author, and evidence before overwriting an established pattern.

### Entity ID Conventions (subject)
- Files: `file:<relative-path>` (e.g. `file:src/config.ts`)
- Symbols: `sym:<relative-path>#<name>` (e.g. `sym:src/policy.ts#isPermissiveTrust`)
- Environment variables: `env:<NAME>` (e.g. `env:LORE_TEAM_SECRET`)
- Packages: `pkg:<name>` (e.g. `pkg:@529studio/lore`)
- Documents: `doc:<relative-path>` (e.g. `doc:AGENTS.md`)
- Architectural decisions: `adr:<NNN>` (e.g. `adr:001`)
- Rules & Guardrails: `rule:<ID>` or `lesson:L<NN>` (e.g. `rule:MCP-001`, `lesson:L04`)

### Standard Predicates
- Rules & Invariants: `enforces_invariant`, `defines_rule`, `has_guardrail`, `has_constraint`
- Architecture & Routes: `decides`, `imports_module`, `exposes_route`, `read_by`, `entrypoint`
- Dependencies: `declared_dependency`, `uses_library`, `package_name`
- Project predicates: `enforces_invariant`, `defines_rule`, `has_guardrail`, `has_constraint`, `decides`, `imports_module`, `exposes_route`, `read_by`, `declared_dependency`, `defines_script`

### Evidence & Trust Tiers (kind & ref)
- Code / Tests: Use `kind: "file"` or `kind: "test"` with `ref: "<relative-path>"`. SHA-256 hashes ensure freshness; if file changes, claims auto-decay to stale.
- Inferences: Use `kind: "agent"`. Writes remain `draft` until reviewed via `lore approve` (or active in solo permissive mode).
<!-- lore:memory-protocol:end -->
