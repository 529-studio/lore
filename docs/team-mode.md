# Team mode: decision brief

Status: **draft for discussion** · affects #15 (Postgres adapter) and #16 (auth and permissions)

Lore today is local-first: one SQLite file per checkout, one OS user. Team mode means several people
and several machines sharing what their agents know. This brief lists the decisions that must be made
before code, with a recommendation for each. It is intentionally opinionated; disagree with the
recommendation, not with the framing.

## What team mode must deliver

1. A reviewer can see what an agent learned and approve or reject it.
2. Two people can work at the same time without corrupting or silently overwriting memory.
3. Every claim says who taught it and who approved it, and that record survives disputes.
4. A local-only user keeps working exactly as today: no server required.

Everything else (dashboards, notifications, hosted SaaS) is downstream of these four.

## Decision 1: storage backend

| Option | Pros | Cons |
|---|---|---|
| **A. Postgres as an optional backend** | real concurrency, backups, one store per team, standard ops | server to run, schema duplication, migration path |
| B. SQLite + sync (push/pull) | offline-first, no server | conflict resolution on top of merge; two sources of truth |
| C. Hosted service only | simplest client | kills local-first; vendor lock-in; we must run it |
| D. SQLite on a shared network drive | no new code | corruption risk, locking is not reliable |

**Recommendation: A.** Keep SQLite as the default and add Postgres behind the same `Store` interface.
It preserves the local story, gives teams a real backend, and does not require inventing sync
semantics. B is a later option if offline teams ask for it.

Open question: one Postgres database per team, or per repository? Recommendation: per repository,
schema `lore`, so a team can use one cluster without mixing projects.

## Decision 2: identity

| Option | Notes |
|---|---|
| `git config user.email` | zero setup, spoofable, good enough for local mode |
| `LORE_USER` env / token | explicit, still spoofable if the machine is shared |
| OIDC / SSO | required for hosted or regulated teams |

**Recommendation:** local mode trusts the OS user and records `git config user.email`; team mode
requires an authenticated identity (OIDC or a per-user token) and records it in every commit and
approval. Never let a client assert an arbitrary author string in team mode.

## Decision 3: permissions

The authority ladder only means something if approval is restricted.

Proposed policy file, versioned with the repository:

```yaml
# lore.policy.yml
approve:
  t3: [maintainers]        # human chat claims
  t4: [maintainers]        # agent inference
resolve:
  "*": [maintainers]
  "sym:src/payments/*": [payments-team]
protected:
  - "sym:src/auth/*"       # requires two approvals
```

**Recommendation:** start with two roles, `contributor` and `maintainer`. Anything richer becomes a
configuration language nobody reads. Enforce in the CLI and MCP; log every denial.

## Decision 4: concurrency semantics

Postgres makes writes safe, not correct. Two people can still approve contradictory claims.

**Recommendation:** keep the existing model — branch per session, merge with the ladder, human
resolution when the ladder cannot decide. Postgres adds row locking for the merge transaction and a
unique constraint on claim ids. Do **not** add realtime collaboration; it is a different product.

## Decision 5: migration

- `lore init --backend postgres` creates the schema and records the connection in `.lore/config.json`.
- `lore migrate --to postgres` copies entities, claims, evidence, commits, refs and merge decisions,
  preserving ids. Ids are content hashes, so a partial copy is still consistent.
- The SQLite store stays valid; teams can switch back for a local experiment.

Open question: what happens when two clones migrate the same history into one database? Claim ids
deduplicate, commits do not (they embed timestamps). Recommendation: migration is a one-time operation
per repository, run by one person, and the result becomes the shared history.

## Decision 6: threat model

| Threat | Mitigation |
|---|---|
| Poisoned memory from an untrusted source | authority tiers plus approval; untrusted content can never exceed T4 |
| Stolen token | per-user tokens, short expiry, audit log of approvals |
| Silent overwrite | merge never overwrites; it retracts and records a decision |
| PII that must be forgotten | retraction plus a hard-delete path for a specific claim, with an audit record |
| Malicious MCP client | tool calls carry an identity; approve/resolve require the maintainer role |

Hard delete does not exist today. Team mode needs a documented exception for legal removal; decide
whether that is a separate command with an audit entry, or an operator-only SQL procedure.

## Decision 7: operations

- Backups: `pg_dump` nightly; the store is small (claims are text).
- Migrations: numbered SQL files, applied on `lore init` and on server start; no ORM.
- Observability: one log line per write and per approval, structured JSON.
- Hosting: a single Postgres instance is enough for tens of teams; do not build a control plane yet.

## What we should not build yet

- Realtime sync, presence, or CRDTs.
- A web admin panel before the read-only dashboard (#18).
- Billing, multi-tenant isolation, or a hosted service.
- Per-field encryption. Disk encryption plus access control first.

## Proposed sprint shape

| Step | Content | Estimate |
|---|---|---|
| 1 | `Store` interface extracted from the SQLite code, no behaviour change | 12h |
| 2 | Postgres implementation plus migration command and CI service container | 24h |
| 3 | Identity and policy file; enforcement in CLI and MCP | 20h |
| 4 | Audit log and approval record | 8h |
| 5 | Docs: team setup, roles, migration, threat model | 8h |

Total ~72h. Do not start step 2 before step 1 is merged: the interface is the expensive part.

## Questions for the team

1. Is the first real user a team of 2-3 developers, or a larger group with a compliance requirement?
   The answer changes whether OIDC is needed in step 3 or later.
2. Does anyone need offline work on a plane? If yes, option B (sync) moves up; if no, Postgres-only is
   enough.
3. Who is allowed to approve agent inference in practice — every developer, or one reviewer?
4. Is "forget this claim" a real requirement in the next 6 months? It changes the data model (hard
   delete plus audit) more than any other item here.
5. Where will Postgres run — the existing self-hosted box, or a managed service?

Answer these five and the sprint can be cut without further design work.
