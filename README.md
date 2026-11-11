# Lore

**Git for what your AI agents know.**

Lore is a memory layer for AI coding agents. It stores what an agent learned as claims with
provenance, detects when those claims go stale, merges memory from agents working in parallel,
and lets you undo a session that learned something wrong.

[![CI](https://github.com/529-studio/lore/actions/workflows/ci.yml/badge.svg)](https://github.com/529-studio/lore/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](package.json)

---

## The problem

If you use more than one AI agent on the same project (Claude Code, Codex, Gemini CLI, Cursor),
their memory today is an append-only log with vector search. It stores, but nobody trusts it:

1. **Dead facts keep living.** The file changed three weeks ago; the memory still describes the old behaviour.
2. **Contradictions are both "true".** Two agents learned different things; search returns both.
3. **You cannot undo a bad session.** Memory that was poisoned stays poisoned.
4. **You cannot ask "who taught the agent this?"** So you never dare rely on it.
5. **Agent B does not trust agent A**, so it redoes the work.

Lore fixes the **trust** problem, not the storage problem.

## What it gives you

| Guarantee | How |
|---|---|
| **Provenance** | Every claim carries evidence with a content hash and an authority tier (T0 test → T4 inference) |
| **Staleness** | On read, evidence is re-hashed; a claim whose file changed is marked stale and drops out of retrieval |
| **Merge** | 3-way merge on `(subject, predicate)` with a deterministic ladder; unresolvable conflicts abort instead of guessing |
| **Undo** | `lore revert` writes an inverse commit. History is never rewritten, so `blame` still works |

## 60-second demo

```bash
npm i -g @529studio/lore        # or install the tarball from Releases

cd my-project
lore init                       # creates .lore/ + lore.ontology.yml
lore ingest                     # derives claims from package.json, env vars, imports, routes, rules
lore status                     # 77 active, 0 draft, 0 stale
lore search "DATABASE_URL"      # ranked claims with evidence and score breakdown
lore blame env:DATABASE_URL     # who/what taught this, and whether it is still true
```

Then edit a file that a claim depends on:

```bash
lore status                     # stale 10  (nothing is deleted)
lore verify --all --strict      # exit 3 — memory health is a CI gate
```

---

## Who this is for

**Works today:** developers and technical teams using one or more coding agents on a repository.
The tool is a CLI plus an MCP server; it needs Node 22+, git, and a terminal.

**Not yet:** people who never open a terminal. There is no app. If that is you, read
[Track B](#track-b--if-you-do-not-use-a-terminal) — there is still a way to benefit, and v0.3 is
the milestone that changes this.

---

## Track A — developer setup

### Prerequisites

- **Node.js 22 or newer** (`node --version`)
- **git** (the extractor uses `git ls-files`, and `lore` stores memory next to the repo)
- An MCP-capable client if you want agents to use it automatically: Claude Code, Codex CLI,
  Gemini CLI, Cursor, or anything else that speaks MCP over stdio.

### Install

Pick one:

```bash
# A. npm (recommended once published)
npm i -g @529studio/lore

# B. release tarball (works today, no registry needed)
curl -L -o lore.tgz https://github.com/529-studio/lore/releases/download/v0.1.0/529studio-lore-0.1.0.tgz
npm i -g ./lore.tgz

# C. from source
git clone https://github.com/529-studio/lore.git && cd lore
npm ci && npm run build && npm link
```

Verify: `lore --version` → `0.1.0`.

### Initialise a repository

```bash
cd my-project
lore init
```

This creates:

```
.lore/lore.db          # SQLite store: claims, evidence, commits, refs
lore.ontology.yml      # which predicates may hold one value vs many
.gitignore             # .lore/ appended, so the store is not committed
```

`lore ingest` then derives claims deterministically (no LLM, no cost):

| Source | Claim example |
|---|---|
| `package.json` | `pkg:zod — declared_dependency — ^4.0.0 (dependencies)` |
| env vars | `env:DATABASE_URL — read_by — src/db.ts` |
| imports | `file:src/api.ts — imports_module — zod` |
| routes | `file:src/routes.ts — exposes_route — GET /health` |
| rule registries | `rule:MCP-001 — detects — Remote endpoint uses plain HTTP` |
| root docs | `doc:README.md — has_section — Quick start` |

Re-running `ingest` is idempotent: claims are content-addressed, so the same fact gets the same id.

### Connect your agents (MCP)

Claude Code:

```bash
claude mcp add lore --scope project \
  --env LORE_SESSION=claude \
  -- node "$(command -v lore)" mcp
```

Codex CLI (`~/.codex/config.toml`):

```toml
[mcp_servers.lore]
command = "node"
args = ["/absolute/path/to/lore/dist/cli.js", "mcp"]
env = { LORE_SESSION = "codex" }
```

Gemini CLI (`~/.gemini/settings.json`):

```json
{
  "mcpServers": {
    "lore": {
      "command": "node",
      "args": ["/absolute/path/to/lore/dist/cli.js", "mcp"],
      "env": { "LORE_SESSION": "gemini" }
    }
  }
}
```

Each client should set its own `LORE_SESSION`, which maps to a branch `agent/<session>`.
Agents never write to `main`; you decide what gets promoted. Full details: [docs/mcp.md](docs/mcp.md).

### Daily workflow

| When | Command | Why |
|---|---|---|
| Start of a task | `lore search "<task>" --files src/x.ts` | give the agent the right 10 claims instead of the whole repo |
| During the task | agent calls `memory_write` | inference lands as `draft`, not trusted yet |
| End of the task | `lore status` → `lore approve <id>` | you review what the agent learned |
| Hand-off | `lore promote` | merge your branch into `main` so other sessions inherit it |
| Something is wrong | `lore blame <subject>` / `lore revert <commit>` | trace it, then undo it |

### Command reference

```
lore init                      initialise .lore/ and the ontology
lore ingest [--dry-run]        derive claims from deterministic extractors
lore write                     write one claim (draft for agent/human evidence)
lore search "<query>"          score the active set; stale excluded by default
lore blame <subject>           provenance: author, evidence, branch membership
lore status [--strict]         health: active, draft, stale, conflicts, GC candidates
lore diff <from>..<to>         claims added/removed between revisions
lore merge <branch>           3-way merge; aborts with exit 2 on real conflicts
lore resolve <subject> <pred>  record a human decision for one conflict
lore promote                   merge the current branch into main
lore revert <commit>           inverse commit, history preserved
lore verify <claim> | --all    re-hash evidence; --strict exits 3 when stale
lore gc [--ttl-days 3]         retract aged drafts (rows are never deleted)
lore export --md               deterministic markdown projection (AGENTS.md)
lore mcp                       MCP server over stdio
```

Exit codes: `0` ok · `2` unresolved merge conflict · `3` stale above threshold.

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `not inside a lore repo` | no `.lore/` above cwd | `lore init` at the repo root |
| `search` returns nothing | empty branch | `lore ingest`, or `lore promote` from the session that has memory |
| claim is `draft` forever | agent inference needs approval | `lore approve <id>` or `lore approve --all-drafts` |
| everything is `stale` | files changed since ingest | `lore ingest`, then `lore verify --all` |
| merge exits 2 | genuine conflict | `lore resolve ... --take ours\|theirs\|both`, then re-run merge |

---

## Track B — if you do not use a terminal

You can still get most of the value today, but someone technical has to set it up once.

**Ask a developer on your team to run these two commands in the project folder:**

```bash
lore init && lore ingest
claude mcp add lore --scope project --env LORE_SESSION=team -- node "$(command -v lore)" mcp
```

After that, you use Claude / Codex / Gemini exactly as before. What changes:

- the agent stops re-discovering the same facts every session;
- when a file changes, the agent is told the old fact is stale instead of repeating it;
- anything the agent "learns" by inference waits for a human `approve` before it is trusted;
- a bad session can be undone.

**What you can read without any tooling:** `lore export --md --out AGENTS.md` produces a plain
markdown file of everything the agent knows, grouped by subject, with the evidence in comments.
It is deterministic, so it reviews like a document in a pull request.

**What does not exist yet:** a window with buttons. The app layer (health, review, undo) is
milestone **v0.3.0**, tracked in
[issue #21](https://github.com/529-studio/lore/issues/21). Until then, "approve" and "undo" mean
asking a developer or running one command.

---

## Track C — team workflow

```
main ──────────●──────────────●─────────  (shared memory)
                \            /
   agent/claude  ●──●──●────●            (one session)
   agent/codex        ●──●──●            (another session)
```

- Every session writes to `agent/<session>`. Nothing lands in `main` by accident.
- `lore promote` merges your branch into `main`. It uses the same 3-way merge and ladder.
- Two agents editing the same fact produce a **conflict**, not a silent overwrite:
  - `T0 test` beats `T1 file` beats `T2 human` beats `T4 inference`;
  - a stale side loses to a verified side;
  - delete-vs-edit resolves to deletion;
  - if nothing applies, the merge **aborts with exit 2** and asks a human.
- `lore resolve <subject> <predicate> --take theirs --reason "..."` records the decision, and the
  next merge applies it. Every decision is stored in `merge_decision` for audit.

---

## How it works

A **claim** is `(subject, predicate, object)` plus:

- **bi-temporal timestamps** — when it became true (`valid_from`) and when we learned it (`tx_from`);
- **authority tier** — T0 test, T1 tool-observed, T2 human-approved, T3 human chat, T4 inference;
- **evidence** — kind, reference, and a content hash taken at observation time.

Claims are immutable and content-addressed, so two agents observing the same fact produce the same
id and merge becomes a set operation instead of a text merge. Commits form a DAG (a merge commit has
two parents). Memory is never deleted: retract, supersede and GC all change state, not rows.

On every read, evidence hashes are recomputed. If a file changed, the claim is **stale** — visible
in `blame`, excluded from `search`, marked in `export`. That is the whole trick: memory behaves like
a cache of reality that can be verified, not a belief system.

Full design and every deviation: [SPEC.md](SPEC.md).

## Evidence, not claims

The repository ships three executable checks; CI runs all of them:

```bash
npm run build        # TypeScript
npm run smoke        # 20+ end-to-end assertions on a throwaway repo
npm run mcp:smoke    # real MCP handshake, tools, draft gating, approve
npm run eval         # outcome metrics, no LLM judge
```

Latest `npm run eval` on the shipped sample fixture (set
`LORE_EVAL_FIXTURES=/path/a,/path/b` to run against your own repositories):

| Metric | Result | Threshold |
|---|---|---|
| stale_rate | 8.0% (worst file 15.5%) | < 15% |
| false_claim_rate | 0.0% | < 5% |
| conflict_rate (merges that should succeed) | 0.0% | < 10% |
| revert_correctness | 100% | 100% |
| token_savings | 71.9% | > 30% |
| time_to_first_useful | 3 invocations | < 10 |

These numbers are proxies (chars/4 for tokens; one generated fixture by default, not twenty
sessions). They are reported as measured; the harness fails the build when a scenario check fails.

## Limitations (v0.1)

- **Bi-temporal is stored, not queryable.** `valid_from` can be written; there is no `--as-of` read yet ([#1](https://github.com/529-studio/lore/issues/1)).
- **Draft GC uses age**, not session count ([#2](https://github.com/529-studio/lore/issues/2)).
- **`verify` does not rewrite hashes**; a legitimately changed file stays stale until `ingest` re-observes it ([#3](https://github.com/529-studio/lore/issues/3)).
- **Code repositories only.** Entity ids come from `path#symbol`, which is what makes merge deterministic. Non-code entities are v0.3 ([#20](https://github.com/529-studio/lore/issues/20)).
- **No team backend yet.** SQLite per repo; shared Postgres and auth are v0.2 ([#15](https://github.com/529-studio/lore/issues/15), [#16](https://github.com/529-studio/lore/issues/16)).

## Contributing

Issues and pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), and read the
project rules in [AGENTS.md](AGENTS.md) — they apply to humans and AI agents alike.

Security reports: [SECURITY.md](SECURITY.md), never a public issue.

## License

MIT © 529 Studio. See [LICENSE](LICENSE).
