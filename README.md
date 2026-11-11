# Lore

> Git for what your agents know.

Versioned, verifiable memory for multi-agent coding. Claims have provenance, expire when the
code drifts, and can be reverted when an agent learns something wrong.

Status: **M0–M4** — init, write, ingest, log, blame, status, approve, gc, diff, revert, merge, resolve, promote, search, verify, export, mcp.

## Why

Agent memory today is an append-only log with vector search. It stores, but nobody trusts it:

1. dead facts keep living after the code changed
2. contradictory facts are both "true"
3. no way to revert a session that learned something wrong
4. no way to answer "who taught the agent this?"
5. agent B doesn't trust agent A, so it redoes the work

Lore fixes the trust problem, not the storage problem.

## Quick start

```bash
npm install && npm run build && npm link

cd path/to/your/repo
lore init                # .lore/ + lore.ontology.yml
lore ingest              # deterministic extraction: package.json, env vars, imports, routes, rules
lore blame env:DATABASE_URL
lore status              # active / draft / stale
```

## Commands

| Command | Purpose |
|---|---|
| `lore init` | create `.lore/` and the ontology file |
| `lore ingest` | scan the repo and write claims from deterministic extractors (T1 authority) |
| `lore write --subject --predicate --object --kind` | write one claim; `agent`/`human` evidence stays draft |
| `lore approve <id> \| --all-drafts` | promote a draft into retrieval |
| `lore log` | commit history of the current session branch |
| `lore blame <subject>` | who/what taught this, with evidence hash |
| `lore status` | counts + drift detection (stale evidence) |
| `lore diff <from>..<to>` | claims added/removed between two revisions |
| `lore revert <commit>` | inverse patch as a new commit — history stays intact |
| `lore merge <branch>` | 3-way merge on `(subject, predicate)`; conflicts abort instead of guessing |
| `lore resolve <subject> <predicate> --take ours\|theirs\|both` | record a human decision for one conflict |
| `lore promote` | merge the current session branch into `main` so other sessions inherit it |
| `lore gc [--ttl-days 3]` | retract drafts nobody used (rows are kept, never deleted) |
| `lore search "<query>" [--files ...] [--budget ...] [--json]` | score the active set, stale excluded by default |
| `lore verify <claim> \| --all [--strict]` | re-hash evidence; exit 3 when stale |
| `lore export --md [--out AGENTS.md]` | deterministic markdown projection |
| `lore mcp` | MCP server over stdio (see [docs/mcp.md](./docs/mcp.md)) |

Exit codes: `0` ok, `2` unresolved merge conflict (M2), `3` stale above threshold.

## Model in one paragraph

A **claim** is `(subject, predicate, object)` plus bi-temporal validity, an authority tier
(T0 test → T4 agent inference), and evidence carrying a content hash. Claims are immutable and
content-addressed, so two agents observing the same fact produce the same id. Commits form a DAG
like git; each session writes to `agent/<session>`. On read, evidence hashes are recomputed —
if the file changed, the claim becomes **stale** rather than silently wrong. Nothing is deleted.

Full design: [SPEC.md](./SPEC.md).

## What works today

- deterministic entity ids (`file:`, `sym:`, `env:`, `pkg:`, `rule:`, `doc:`)
- claim dedupe by content hash (re-running `ingest` writes 0 new claims)
- draft gating: agent inference does not enter retrieval until approved
- drift detection: edit a file, `lore status` reports every dependent claim as stale; restoring the file clears it
- per-session branches, commit log with claim entries
- `diff` between any two refs/commits, `revert` (and revert-of-revert restores)
- 3-way merge with the R1–R6 ladder (cardinality, authority, staleness, recency); unresolved conflicts abort with exit 2
- `npm run smoke` — end-to-end test on a throwaway repo

## Not yet (M3–M5)

- MCP server
- markdown projection into `AGENTS.md`
- eval harness (stale rate, false-claim rate, revert correctness, token savings)
