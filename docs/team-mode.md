# Team mode: decision brief (v2)

Status: **decided, ready to cut** · affects #15 (shared backend), #16 (auth and permissions),
#49 (sync and repo identity), #50 (redact and purge), #51 (secret firewall), #52 (policy engine)

v2 records the answers from the team and the architecture they imply. The central change from v1:
**memory is decoupled from the git host.** Teams use internal GitLab, Azure DevOps, or no remote at
all; memory still has to be shared.

## What team mode must deliver

1. A reviewer can see what an agent learned and approve or reject it.
2. Two people work at the same time without corrupting or silently overwriting memory.
3. Every claim says who taught it and who approved it, and that record survives disputes.
4. A local-only or air-gapped repository keeps working with no server.
5. Memory can be newer than a colleague's checkout, and the tool says so instead of lying.

## Decisions from the team

| Question | Answer | Consequence |
|---|---|---|
| First team | 2-3 developers, internal repos that cannot be pushed public | No dependency on GitHub; identity from a corporate IdP |
| Offline | Required; some repositories never leave the machine | Local-first is the default, not a fallback |
| Reviewers | One human reviewer plus an optional independent audit agent; automation later | Policy engine with human, machine and n-of-m approvers |
| Delete | Needs a defined meaning (see below) | Redact and purge as separate operations |
| Postgres | Self-hosted, or corporate-managed with a shared connection | Support both; no cloud assumptions |

## Architecture

```
Postgres (team transport)              optional, self-hosted or corporate-managed
      ^  push / fetch a commit bundle
SQLite .lore (source of truth locally) always present, works offline
      ^  MCP / CLI
Claude, Codex, Gemini, ...
```

Postgres is a **transport**, not the query backend: one row per repository in `lore_bundles`, holding
the commit bundle. This keeps offline first-class and avoids rewriting every query to be asynchronous.
A query-level backend would only be needed for a hosted dashboard; the read-only dashboard (#18) can
read the local store.

- **Repository identity is not the git remote.** A UUID is generated once into `.lore/config.json`.
  Azure DevOps, GitLab self-host, a bare directory and a public GitHub repo all work the same way.
- **Sync is the commit DAG, not a new protocol.** `lore fetch` pulls missing commits and merges them
  with the existing ladder. `lore push` sends local commits. There is no CRDT and no realtime channel.
- **Offline is a queue.** Writes always land locally; push happens when a remote is configured and
  reachable. Nothing blocks on the network.
- **Air-gapped sharing uses bundles.** `lore bundle export` writes the missing commits, signed and
  encrypted; `lore bundle import` merges them. This replaces passing `AGENTS.md` around by hand.

### Two kinds of freshness

A colleague can fetch memory about code they have not pulled. That is not staleness.

| Axis | Question | Behaviour |
|---|---|---|
| Memory | Is the shared store ahead of my local commits? | `lore fetch`; `status` shows `memory ahead by N commits` |
| Code | Does the evidence hash match the file on this machine? | if not, the claim is **ahead of checkout**, not stale: excluded from default retrieval, shown with a warning, still visible in `blame` |

`--trust-remote` accepts the remote evidence hash when the local file is absent, so a reviewer can read
memory for a branch they do not have.

## Permissions and automation

`lore.policy.yml`, versioned in the repository:

```yaml
approve:
  t0: [anyone]          # test-verified
  t1: [anyone]          # tool-observed
  t3: [maintainers]
  t4: [maintainers]     # inference is never auto-approved
resolve:
  "*": [maintainers]
  "sym:src/payments/*": [payments-team]
protected:
  - "sym:src/auth/*"    # two approvals
audit:
  agent: [lore-auditor] # read-only principal, signs attestations
```

Three kinds of approver:

| Approver | Evidence it must attach | Notes |
|---|---|---|
| Human | role from the policy | default |
| Machine | policy version + the rule it applied | only for T0/T1 |
| N-of-M | one human plus one audit attestation | for protected subjects |

**Separation of duties:** an audit agent cannot approve its own write. Its output is a signed
attestation, stored as a claim with authority T2 and linked to the claims it reviewed.

**When humans only check the UI:** review policy changes and a digest, not every claim. The digest
reports claims added, conflicts resolved, auto-approvals by policy, audit disagreements, and rollbacks.
Sampling plus a rollback button is the control; per-claim review does not scale.

## Redact and purge

Three distinct operations exist; the first two are implemented, purge is implemented with a single
confirmation and will require two approvals once auth lands:

| Operation | Effect | Who |
|---|---|---|
| `retract` | state changes; content stays; `blame` still shows it | author or maintainer |
| `redact` | content replaced with `[redacted]`, **id kept**, audit row records who and why | maintainer |
| `purge` | row removed from the store; audit row keeps id, actor, reason, never the content | maintainer, two approvals |

Redaction keeps the id because ids are content hashes and history references them. A `redaction` table
records the original hash, actor, reason and timestamp. Purging without an audit row is not allowed.

Use cases: PII, a secret written into memory, a legal deletion request.

## Secrets

The threat is not only "a secret in a file". It is an agent reading a value and writing it into code or
memory. Prevention is layered; no single layer is sufficient.

| Layer | Control |
|---|---|
| Do not expose | `.env` outside the agent sandbox; inject secrets at process start; context files carry names, not values |
| Do not store | `lore` scans every claim write; a match is rejected and never persisted; MCP redacts documents before returning them |
| Do not commit | `lore guard --staged` in a pre-commit hook; CI; host push protection; pre-receive hook on self-hosted GitLab/ADO |
| Contain | canary tokens, short-lived credentials, least privilege, rotation runbook |

`lore guard` scans staged files for provider prefixes, high-entropy tokens and credential assignments,
and prints a masked match. It is a gate, not a guarantee: assume a secret can leak and rotate.

## Operations

- Postgres self-hosted or corporate-managed; connection string from the environment or a secret
  manager, never from the repository.
- TLS required; one schema per repository (`lore`); numbered SQL migrations, no ORM.
- Backups: `pg_dump` nightly. The store is text; size is not a problem.
- Observability: one structured log line per write and per approval.
- No control plane, billing or multi-tenant isolation yet.

## Sprint shape

| Step | Content | Estimate |
|---|---|---|
| 0 | Secret firewall and `lore guard` (issue #51) | 10h |
| 1 | Repository identity, `fetch`/`push`, bundles (#49) | 24h |
| 2 | `Store` interface, then Postgres and migration (#15) | 36h |
| 3 | Identity and policy enforcement (#16) | 20h |
| 4 | Redact and purge (#50) | 12h |
| 5 | Policy engine and audit attestations (#52) | 24h |
| 6 | Docs: team setup, roles, migration, secret handling | 8h |

Total ~134h. Step 0 ships first because it protects every later step.

## Remaining open questions

1. Where does the corporate IdP live (Azure AD, Keycloak, something else)? This decides whether step 3
   uses OIDC or per-user tokens.
2. Is there a compliance requirement that forces purge within a deadline? If yes, step 4 moves up.
3. Who owns the Postgres instance operationally — the team, or a platform group?
4. Do internal repositories share one Postgres database or one schema per repository? Recommendation:
   one schema per repository, one database per team.
