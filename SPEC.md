# Lore — SPEC v0.2

> **Git for what your agents know.**
> Versioned, verifiable, mergeable memory for multiple agents and models working on one project.

Status: implemented for M0–M4; see §15 for every place the code deviates from this document.

---

## 1. Problem

Agent memory today is an append-only log plus vector search. It stores, but nobody trusts it.
Five symptoms, in order of severity:

| # | Symptom | Consequence |
|---|---|---|
| F1 | Dead facts keep living (the file changed, memory did not) | the agent edits the wrong thing and burns tokens |
| F2 | Two contradictory facts are both "true" | retrieval returns both and the model picks arbitrarily |
| F3 | A bad session cannot be reverted | poisoned memory stays poisoned |
| F4 | "Who taught the agent this?" is unanswerable | nobody dares rely on memory |
| F5 | Agent B does not trust agent A and redoes the work | multi-model setups cannot share effort |

**What Lore is not:** a note-taking app, a chatbot memory, or a vector database.

## 2. Non-goals (v0)

- Not universal. v0 targets **code repositories**, where entity resolution is free via symbol ids.
- No realtime sync between running agents. Merge is branch-per-session, merged when done (like a PR).
- No web UI. CLI + MCP + markdown projection.
- No embedding store of our own. Vector similarity is an optional tiebreak, never the source of truth.
- No multi-tenant cloud.

## 3. Invariants

1. **Claims are immutable.** Editing means a new claim plus a commit. Content is never UPDATEd.
2. **Nothing is hard-deleted.** Retract, supersede and GC change state; rows remain. Audit must answer
   "what did the agent believe in September".
3. **Every claim has evidence.** A claim without evidence may exist only as a `draft`, and drafts are
   retracted by GC.
4. **Conflicts are never guessed.** Resolution follows a deterministic ladder (§7); when no rule
   applies the merge aborts and a human decides.
5. **Reads verify.** Memory is a cache of reality. Evidence hashes are recomputed on read.

## 4. Model

```
Entity   ── subject of a claim. Deterministic id, never chosen by an LLM.
Claim    ── (subject, predicate, object) + time + evidence + authority.
Commit   ── immutable snapshot of the active set. A DAG, like git.
Branch   ── pointer to a commit: main, agent/<session>.
Merge    ── 3-way on the fact key (subject, predicate[, object]).
```

### 4.1 Entity

| Kind | Format | Source |
|---|---|---|
| `symbol` | `sym:<path>#<qualified_name>` | tree-sitter / LSP |
| `file` | `file:<path>` | filesystem |
| `test` | `test:<path>#<test_name>` | test runner |
| `issue` | `issue:<provider>:<id>` | tracker |
| `person` | `person:<email>` | git author |
| `env` | `env:<NAME>` | source scan |
| `pkg` | `pkg:<name>` | manifest |
| `doc` | `doc:<path>` | markdown |
| `concept` | `concept:<slug>` | human/agent, weakest |

Entity resolution must be deterministic: two agents observing the same fact must produce the same id.
In a code repository, never use embeddings to resolve an entity — `path#symbol` is unique and stable.

### 4.2 Claim

```yaml
id:          c_9f2a1b...            # content hash (§5.1)
subject:     sym:src/payments/refund.ts#refundOrder
predicate:   requires_idempotency_key
object:      "Stripe idempotencyKey required on retry"
valid_from:  2026-09-02             # when it became true (world time)
valid_to:    null
tx_from:     2026-11-10T03:11Z      # when we learned it (transaction time)
authority:   0                      # 0..4, see §7
confidence:  0.9
author:      agent:codex/ses_01J...
supersedes:  c_7a1b...
state:       active                 # draft | active | retracted
evidence:
  - kind: test
    ref:  tests/refund.test.ts#L42
    hash: sha256:9c1e...
    verified_at: 2026-11-10T03:11Z
    status: valid                   # valid | stale
```

Bi-temporal fields are mandatory in the model: without them there is no clean revert and no
"what did we believe last week".

### 4.3 Evidence

| kind | Meaning | Hashed |
|---|---|---|
| `test` | a test or CI result | test file + commit |
| `file` | observed file content | file content |
| `command` | observed command output | command + output |
| `human` | a person said or approved it | message + author |
| `agent` | model inference | prompt + model id |

Evidence is not proof. It is an anchor for detecting drift.

## 5. Storage

### 5.1 Canonical hash

`claim_id = "c_" + sha256(stableStringify({subject, predicate, object, valid_from}))[0..32]`.
`tx_from`, evidence and confidence are excluded so two agents observing the same fact collide by
design. JSON keys are sorted; the encoding is stable across languages.

### 5.2 Schema (SQLite)

```sql
CREATE TABLE entity (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, canonical TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE claim (
  id          TEXT PRIMARY KEY,
  subject_id  TEXT NOT NULL REFERENCES entity(id),
  predicate   TEXT NOT NULL,
  object_json TEXT NOT NULL,
  valid_from  TEXT, valid_to TEXT,
  tx_from     TEXT NOT NULL,
  authority   INTEGER NOT NULL CHECK (authority BETWEEN 0 AND 4),
  confidence  REAL NOT NULL,
  author      TEXT NOT NULL,
  supersedes  TEXT REFERENCES claim(id),
  state       TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','active','retracted'))
);
CREATE INDEX claim_key ON claim(subject_id, predicate);

CREATE TABLE evidence (
  claim_id TEXT NOT NULL REFERENCES claim(id),
  kind TEXT NOT NULL, ref TEXT NOT NULL, hash TEXT,
  verified_at TEXT, status TEXT NOT NULL DEFAULT 'valid',
  PRIMARY KEY (claim_id, kind, ref)
);

CREATE TABLE memory_commit (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES memory_commit(id),
  merge_parent_id TEXT REFERENCES memory_commit(id),
  tree_hash TEXT NOT NULL, message TEXT NOT NULL,
  author TEXT NOT NULL, ts TEXT NOT NULL, kind TEXT NOT NULL
);

CREATE TABLE commit_entry (
  commit_id TEXT NOT NULL REFERENCES memory_commit(id),
  claim_id  TEXT NOT NULL REFERENCES claim(id),
  op TEXT NOT NULL CHECK (op IN ('add','supersede','retract','restore')),
  PRIMARY KEY (commit_id, claim_id, op)
);

CREATE TABLE ref (name TEXT PRIMARY KEY, commit_id TEXT NOT NULL REFERENCES memory_commit(id));
```

The table is `memory_commit` because `commit` is a SQLite keyword. `tree_hash` hashes sorted
`claim_id:op` pairs, so a draft snapshot and an active snapshot cannot collide.

### 5.3 Active set

`active(commit)` folds `commit_entry` over the DAG in topological order (parents before children,
both parents included) and keeps only claims whose state is `active`. Drafts are never committed.

## 6. Write path

```
agent writes → claim state=draft → promote? → active
```

**Auto-promote** (no human) when evidence is:
- `test` with a valid hash, or
- `file` with a hash matching at write time, or
- `command` with an output hash.

**Never auto-promote:** `agent` inference (needs approval or reuse in two sessions) and `human` chat
(chat is an injection surface).

**GC:** a draft nobody reviewed for `ttl_sessions` becomes `retracted`. Sessions are registered by
any command; "reviewed" means the claim appeared in `blame`. `--ttl-days` remains as an explicit
override for stores without session history.

**Injection rule:** content read from an untrusted source (issue comment, web page, another agent's
output) may never carry authority ≥ 2 until verified.

## 7. Merge

### 7.1 Three steps

1. `base = active(lca(ours, theirs))`
2. `ours = active(ours_tip)`, `theirs = active(theirs_tip)`
3. For every fact key in the union, apply the ladder.

A **fact key** is `(subject, predicate)` for `cardinality: one` and `(subject, predicate, object)` for
`cardinality: many`. Many-valued predicates therefore never collide; they coexist by construction.

### 7.2 Ladder

```
R1  cardinality many        → structural: different objects are different keys
R2  authority tier differs  → lower tier wins (T0 beats T4)
R3  one side stale          → the verified side wins
R4  delete vs edit          → deletion wins unless the surviving side is unverifiable (T>2)
R5  same tier, one verified → newer tx_from wins; equal timestamps never decide
R6  nothing applies         → ABORT, exit 2, persist merge_conflict rows
```

Every decision is written to `merge_decision` with the rule and reason. A losing claim is never
deleted: it is retracted and remains visible to `blame`.

### 7.3 Ontology

`lore.ontology.yml` at the repository root, versioned:

```yaml
predicates:
  requires_idempotency_key: { cardinality: one,  domain: symbol }
  uses_library:            { cardinality: many, domain: symbol }
```

Unknown predicates default to `one`.

### 7.4 Revert and promote

`revert` creates a new commit that inverts the target commit's entries. History is never rewritten.
`promote` merges the current branch into `main` with the same ladder, recording the merged branch as
the second parent.

## 8. Staleness

Every claim carries the hash of what it depends on. On read (and in `status`):

| kind | Stale when |
|---|---|
| `file`, `test` | the content hash no longer matches |
| `command` | after one session (outputs age) |
| `human` | never |
| `agent` | the model id changed |

Consequences: retrieval excludes stale claims by default (`--include-stale` overrides); `status`
reports the count; `export` marks them. Stale claims are kept, never deleted, and return to valid when
re-observed.

## 9. Retrieval

Not vector search. Vector is a tiebreak at most.

```
score = 3.0 * anchor        # evidence/subject path is in scope
      + 2.0 * proximity     # 1-2 hops through imports / same directory
      + 1.5 * authority     # (4 - tier) / 4
      + 1.0 * verified      # recency of verification, 14-day window
      + 0.5 * similarity    # token overlap
      - 10.0 * stale
```

`searchClaims(db, root, {query, files, symbols, budgetTokens, includeStale})` returns hits with the
score breakdown, so a human can audit why something ranked high. The budget is approximate tokens
(chars/4), consumed in score order.

## 10. Interfaces

### 10.1 CLI

```
lore init | ingest | write | search | blame | status
lore diff | merge | resolve | promote | revert
lore verify | gc | export --md | mcp
```

Exit codes: `0` ok, `2` unresolved conflict, `3` stale above threshold.

### 10.2 MCP

```
memory_search({query, files, symbols, budget_tokens, include_stale})
memory_write({subject, predicate, object, kind, ref, confidence})
memory_blame({subject, predicate})
memory_status({})
memory_diff({from, to})
memory_approve({claim})
memory_commit({message})
```

`memory_write` never writes to `main`; it always lands on `agent/<session>`.

### 10.3 Markdown projection

`lore export --md` emits a deterministic file: sorted by subject, then predicate, then object; header
without timestamps; evidence in an HTML comment. Deterministic output means it reviews like a
document and diffs cleanly in git.

## 11. Eval

No LLM judge. Outcome metrics on real repositories:

| Metric | Definition | v0 threshold |
|---|---|---|
| `stale_rate` | active claims whose evidence drifted / total | < 15% |
| `false_claim_rate` | claims contradicted by ground truth / checked | < 5% |
| `conflict_rate` | aborts among merges that should succeed | < 10% |
| `revert_correctness` | active set equals the pre-write snapshot | 100% |
| `token_savings` | tokens to answer via `search` vs reading files | > 30% |
| `time_to_first_useful` | invocations before a claim is read back | < 10 |

`revert_correctness` and `token_savings` decide whether the product lives.

## 12. Milestones

| Milestone | Content |
|---|---|
| M0 | init, schema, write (draft), ingest, log, blame, status |
| M1 | commit DAG, diff, revert |
| M2 | 3-way merge, ladder, resolve |
| M3 | verify, retrieval scoring, stale-aware search |
| M4 | MCP server, markdown projection |
| M5 | eval harness |

## 13. Open questions

- Entity resolution outside code (issues, ADRs, decisions) — what replaces `path#symbol`?
- Ontology: hand-written, or bootstrapped from observed predicates?
- Cross-repository memory: share, or import?
- Incremental rehashing: is an mtime cache enough at 1M files?
- Encryption at rest: ours, or the OS?

## 14. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Vendors ship native memory branches | high | cross-vendor is the only defensible position |
| Too many merge conflicts | medium | branch per session, merge at task end, `many` cardinality |
| Write path too strict, agents stop writing | medium | auto-promote T0/T1; only inference is gated |
| Rehashing is slow on big repos | medium | incremental cache (#4) |
| Users do not understand authority tiers | high | hide them until a conflict appears |

## 15. Deviation log

| SPEC says | Code does | Why |
|---|---|---|
| table `commit` | `memory_commit` | `commit` is a SQLite keyword |
| merge only | also `promote` | `main` must advance or new sessions start empty |
| R4 "unless the retract is stale" | approximated by the survivor's tier (> T2 blocks deletion) | no per-side stale flag at that step yet |
| `tree_hash = (claim_id, state)` | `(claim_id, op)` | op is what the fold actually uses |
| `verify` updates the hash | does not rewrite it | avoid blessing drift; `ingest` is the re-observation path |
| `conflict_rate` over 20 sessions | aborts among merges expected to succeed; deliberate conflicts reported separately | measuring a designed conflict against a production threshold is a category error |
| MCP has five tools | seven (`memory_approve`, `memory_commit` added) | without approve, MCP-only memory is permanently invisible |

## Glossary

- **Claim** — a sourced assertion: "refundOrder requires an idempotency key".
- **Evidence** — the observation backing a claim, with a hash to detect drift.
- **Authority tier** — source trust level, T0 (test) to T4 (inference).
- **Stale** — the thing a claim points at changed since it was observed.
- **Merge base** — lowest common ancestor, used for the 3-way merge.
- **Fact key** — the unit merge compares: `(subject, predicate)` or the triple for many-valued predicates.
