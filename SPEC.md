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
2. **Nothing is hard-deleted by default.** Retract, supersede and GC change state; rows remain. Two
   explicit exceptions exist for PII and leaked secrets: `redact` removes the object while keeping the
   id and an audit row, and `purge` removes the row and its evidence while keeping an audit entry.
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
| `section` | `doc:<path>#<heading-slug>` | markdown heading |
| `adr` | `adr:<NNN>` | ADR file naming convention |
| `issue` | `issue:local:<id>` | exported issue file under `issues/` |
| `concept` | `concept:<slug>` | human/agent, weakest |

Aliases (`alias` table, `lore alias`) map a human phrase to an entity id; they are explicit, reviewed,
and used by `blame` and `search`. `lore rename` moves entities and evidence after a file rename and
keeps the old path as an alias.

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
state:       active                 # draft | active | retracted (branch membership, Lore)
trust:       canonical              # canonical | candidate | contested | stale | retracted (Canon)
last_verified_at: 2026-11-10T03:11Z  # newest observation; TTL and decay read this
written_by:  agent                  # agent | human | legacy (backfilled)
session_id:  ses_01J...
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
  state       TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','active','retracted')),

  -- Canon trust axis, separate from branch membership.
  trust          TEXT NOT NULL DEFAULT 'candidate'
                 CHECK (trust IN ('canonical','candidate','contested','stale','retracted')),
  ttl_days       INTEGER,
  last_verified_at TEXT,
  confirmations  INTEGER NOT NULL DEFAULT 0,
  contradictions INTEGER NOT NULL DEFAULT 0,
  invalidated_by_json TEXT,
  written_by     TEXT NOT NULL DEFAULT 'legacy',
  agent_id       TEXT,
  session_id     TEXT,
  run_id         TEXT,
  tags_json      TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX claim_key ON claim(subject_id, predicate);

CREATE TABLE evidence (
  claim_id TEXT NOT NULL REFERENCES claim(id),
  kind TEXT NOT NULL, ref TEXT NOT NULL, hash TEXT,
  commit_id TEXT,
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

A tier-1 Canon conflict is recorded in `claim_conflict`:

```sql
CREATE TABLE claim_conflict (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id TEXT NOT NULL,
  predicate TEXT NOT NULL,
  left_claim TEXT NOT NULL REFERENCES claim(id) ON DELETE CASCADE,
  right_claim TEXT NOT NULL REFERENCES claim(id) ON DELETE CASCADE,
  tier INTEGER NOT NULL DEFAULT 1,
  reason TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  resolved_by TEXT,
  UNIQUE (left_claim, right_claim)
);
```

The pair is stored with sorted claim ids, so a later re-observation cannot duplicate it.

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

**Tier-1 conflict on write:** when an active claim is written for a `cardinality: one` predicate and
another live, non-superseded claim asserts a different object, both become `contested` and one row
lands in `claim_conflict` (tier 1). `contradictions` increments on each new pair. `cardinality: many`
never conflicts, drafts wait for approval, and an explicit `supersede` is replacement, not conflict.
Re-writing the same value is a no-op.

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

A second case must be distinguished: the claim was observed on **newer code than this checkout**
(evidence records the git HEAD at observation time). That claim is `ahead-of-checkout`, not stale:
excluded from retrieval by default, included with `--trust-remote`, and labelled as such in `blame`.

Consequences: retrieval excludes stale claims by default (`--include-stale` overrides); `status`
reports stale and ahead separately; `export` marks them. Stale claims are kept, never deleted, and return to valid when
re-observed.

**Decay.** Canon adds two first-class triggers on top of the evidence hash: `ttl_days` (null by
default, measured from `last_verified_at`) and `path-disappeared` (a file/test evidence path no
longer exists). `lore canon decay` evaluates live claims and persists `trust = stale` with the
trigger in `invalidated_by_json`; the read path checks TTL and disappeared paths lazily, so a claim
cannot be injected between sweeps. A commit that is no longer an ancestor remains `ahead-of-checkout`,
never stale. `lore canon confirm` and `lore verify --accept` clear the trigger, refresh
`last_verified_at`, and restore `canonical` (or `contested` while a tier-1 conflict is open).

## 9. Retrieval

Not vector search. Vector is a tiebreak at most.

**Injection requires `active AND canonical`.** `candidate`, `contested`, `stale` (trust) and
`retracted` claims are never returned. A contested fact contributes one warning line per
`subject:predicate` and no content; the caller can run `lore explain` for both sides.

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
lore explain | canon status | canon decay | canon confirm | canon resolve | canon metrics
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
`memory_search` returns only `active AND canonical` claims; contested facts add `warnings` and a
`contested` array to `structuredContent`, and never contribute content.

### 10.3 Markdown projection

`lore export --md` emits a deterministic file: sorted by subject, then predicate, then object; header
without timestamps; evidence in an HTML comment. Deterministic output means it reviews like a
document and diffs cleanly in git. Canon keeps only canonical claims inline; non-canonical claims are
listed under `Withheld by Canon` without their object.

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
| purge exists as an audited exception | `lore purge --yes` deletes the row; `purge_audit` keeps id/actor/reason | PII and leaked secrets must be removable |
| no machine approver | policy tiers without `*` gate promotion; `LORE_MACHINE=1` may approve T0/T1 only | automation needs a gate that is not a human |
| no attestation | `lore attest` writes a T2 claim linked in `attestation`; no self-attestation | independent review must be attributable |
| no identity | local OS user; team mode uses HMAC tokens or an asserted OIDC email, enforced by `lore.policy.yml` | actions that grant trust must be attributable |
| one state axis | `state` stays branch membership; `trust` (canonical/candidate/contested/stale/retracted) is a second column, backfilled once by evidence hash or commit | shared memory needs a trust signal that is not branch-local |
| conflicts only surface at merge | a tier-1 conflict is recorded synchronously on write; both live claims become `contested` | shared memory must not serve two values silently |
| retrieval filters drafts and stale evidence | retrieval also requires `trust = canonical`; contested facts produce a warning line, never content | trust is orthogonal to branch membership and freshness |
| stale is derived on read | `canon decay` persists `trust = stale` with `invalidated_by_json`; the read path lazily checks TTL and disappeared paths | shared memory needs a durable stale answer and a reason |
| evidence commit must be an ancestor | a non-ancestor stays `ahead-of-checkout`, not stale | an older checkout must not invalidate an observation made on newer code |
| sync carries commits only | bundle import also merges per-claim trust: retracted wins, then newer verification, then the more restrictive trust; conflict resolution flags propagate | a fetch must not resurrect a contested value |
| canonical trust changes only through evidence | `canon resolve` keeps one live value and retracts the rest; redact/purge/GC close the pair and restore the survivor | contested memory needs a deliberate, auditable exit |
| no team sync | `lore remote` + `fetch`/`push` over a shared directory or Postgres, `bundle` for air gaps | internal and air-gapped repositories cannot depend on a git host |
| `--as-of` reads the commit at that instant | folds the whole ancestry, skipping commits after the instant | a single commit chain hides facts on sibling branches before a merge |
| hash cache keyed by content | keyed by size, mtime and ctime | mtime can be restored; ctime changes on any inode write |
| file/test evidence auto-promotes | only when the evidence hash was actually observed | an unhashable file is not evidence |
| `conflict_rate` over 20 sessions | aborts among merges expected to succeed; deliberate conflicts reported separately | measuring a designed conflict against a production threshold is a category error |
| MCP has five tools | seven (`memory_approve`, `memory_commit` added) | without approve, MCP-only memory is permanently invisible |

## Glossary

- **Claim** — a sourced assertion: "refundOrder requires an idempotency key".
- **Evidence** — the observation backing a claim, with a hash to detect drift.
- **Authority tier** — source trust level, T0 (test) to T4 (inference).
- **Trust** — Canon's independent axis: `canonical` may be injected, `candidate` waits for evidence
  or approval, `contested` has a competing value, `stale` failed TTL or drift, `retracted` was
  rejected. Branch membership (`state`) is set by Lore; trust is set by Canon.
- **Stale** — the thing a claim points at changed since it was observed.
- **Merge base** — lowest common ancestor, used for the 3-way merge.
- **Tier-1 conflict** — two live claims assert different values for a `cardinality: one` predicate;
  both become `contested` and a `claim_conflict` row is recorded. No model decides the winner.
- **Fact key** — the unit merge compares: `(subject, predicate)` or the triple for many-valued predicates.
