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
lore-hub (HTTPS + MCP gateway)         primary team transport (Postgres-backed on server)
      ^  delta pull / push / proposals (per-user Bearer token)
SQLite .lore (source of truth locally) always present, works offline
      ^  MCP / CLI
Claude, Codex, Gemini, ...
```

`lore-hub` is the primary team transport: developers hold per-user bearer tokens and never need
`LORE_DB_PASSWORD` or `LORE_TEAM_SECRET` on their machines — see [hub](hub.md). SQLite `.lore/lore.db`
remains the local source of truth so offline work and local retrieval never block on the network.
Direct PostgreSQL sync (`lore_bundles` + `LORE_TEAM_SECRET`) stays available only as a legacy fallback.

- **Repository identity is not the git remote.** A UUID is generated once into `.lore/config.json`.
  Azure DevOps, GitLab self-host, a bare directory and a public GitHub repo all work the same way.
- **Sync is the commit DAG, not a new protocol.** `lore fetch` pulls missing commits and merges them
  with the existing ladder. `lore push` sends local commits. There is no CRDT and no realtime channel.
- **Trust travels with the claims.** Import merges per-claim trust: retracted wins, then the newer
  `last_verified_at`, then the more restrictive state. A conflict or a resolution cannot be silently
  undone by `fetch`.
- **Offline is a queue.** Writes always land locally; push happens when a remote is configured and
  reachable. Nothing blocks on the network.
- **Air-gapped sharing uses bundles.** `lore bundle export` writes the missing commits, signed and
  encrypted; `lore bundle import` merges them. This replaces passing `AGENTS.md` around by hand.
- **Streaming SQLite replication is backup only.** `lore replicate` streams SQLite WAL frames to S3,
  Cloudflare R2, Azure Blob, or GCS for an explicit single-writer backup. It is not a team transport:
  two writers on one replica lose each other's commits, so team sync never selects it implicitly.
- **Bi-directional synchronization (`lore sync`, `memory_sync`).** `createSyncAdapter` dispatches on
  the configured remote (`http` -> lore-hub, `postgres`, `dir`), reconciles incoming claims through
  the 3-way merge ladder, fast-forwards the session branch, and writes `SYNC_INCOMING` /
  `SYNC_OUTGOING` audit rows. MCP sessions also pull a non-blocking delta on `initialize`.

## Joining a clone

A shared repository commits `.lore.yml` at its root. With `lore-hub` (recommended):

```yaml
repo_id: 1f0c2f7e-4f0a-4a8f-9f0d-2b6f7c9e1a33
remote:
  type: http
  url: https://lore-hub.example
  token_env: LORE_HUB_TOKEN
extractors: [code, docs]
```

Never put a URL with credentials, a password, or a token in this file. `npm run check:public` rejects
those in any tracked `.lore.yml` (`token_env` names an environment variable, never a secret value).

`lore join` in a fresh clone reads the manifest, initialises `.lore/` with the committed `repo_id`
(never a random UUID), writes the local remote, and fetches the team baseline so `lore search` works
immediately. `url_env` stays an environment-variable name; a `dir` path resolves relative to the
checkout. `--no-fetch` configures the store without pulling.

`lore init` and `lore onboard` in a manifest repo adopt the same `repo_id` and remote. If the local
store already belongs to another `repo_id`, they refuse to continue instead of forking team memory
or overwriting the manifest.

Remote forms: `http` (`lore-hub`, recommended), `postgres` with `url_env` (legacy fallback), or
`dir` with a relative path for local/offline sharing. The manifest carries no secrets and no personal
agent configuration.

### Legacy / Direct-Postgres Fallback (`team_mode: true`)

Teams without `lore-hub` can sync directly against PostgreSQL using `type: postgres` and HMAC-signed
`LORE_TOKEN` credentials backed by `LORE_TEAM_SECRET`:

```yaml
repo_id: 1f0c2f7e-4f0a-4a8f-9f0d-2b6f7c9e1a33
team_mode: true
remote:
  type: postgres
  url_env: LORE_TEAM_DB_URL
extractors: [code, docs]
```

In this legacy mode, `team_mode: true` is authoritative: it turns local policy enforcement on even
when `LORE_TEAM_SECRET` is missing, and any write fails closed with an explicit error instead of
falling back to a local maintainer identity. A clone can neither disable `team_mode` locally nor act
as a maintainer without `LORE_TOKEN` (signed with `LORE_TEAM_SECRET`) or a trusted `LORE_OIDC_EMAIL`
assertion. Hub (`type: http` / `hub`) remotes enforce authorization server-side via bearer tokens and
do not require `LORE_TEAM_SECRET` on developer machines.

## Git worktrees

Linked worktrees (`git worktree add`, agent orchestrators, Cursor/Claude parallel checkouts) share
the primary checkout's store by default. `.lore/` is gitignored, so without this a worktree would
either fail with `not inside a lore repo` or create a second `repo_id`.

- `workspaceRoot` is the checkout you run in: file hashing, `git HEAD`, `lore.policy.yml` and
  `lore.ontology.yml` resolve here.
- `stateDir` is the primary `.lore/`: `lore.db`, `config.json`, `session` and `litestream.yml`.
- Each worktree gets a deterministic `agent/wt_<hash>` session branch; its session file lives in
  that worktree's git dir, so two checkouts never share a branch. `LORE_SESSION` overrides it.
- `file_hash` is keyed by workspace id, so worktrees on different commits do not thrash or
  misreport each other's hashes.
- `"worktree_mode": "isolated"` in a worktree's local `.lore/config.json` keeps a separate store
  (useful for a throwaway clone that must not touch team memory).
- Env overrides: `LORE_WORKSPACE_ROOT` (checkout) and `LORE_STATE_DIR` (the `.lore` directory).
- `lore init` in a linked worktree attaches the shared store, and does not edit the tracked `.gitignore`.
- If Git cannot name the primary checkout (`git init --separate-git-dir`), Lore fails closed and asks
  for `LORE_STATE_DIR` instead of silently forking the store.

## Synchronization lifecycle

The transport comes from the configured remote, never from the Litestream binary:

| Remote | Adapter | Pull | Push |
|---|---|---|---|
| `http` (lore-hub) | `HttpSyncAdapter` | delta since `hub_seq`, CAS-aware | pull, delta vs hub main, policy |
| `postgres` | `PgSyncAdapter` | read the `lore_bundles` row and import | advisory-lock read-modify-write |
| `dir` | `DirSyncAdapter` | read `<repo_id>.lorebundle` | import, then write the bundle |
| `--replica <url>` | `LitestreamSyncAdapter` | restore a scratch DB and import main | WAL checkpoint only |

`lore sync` and MCP `memory_sync` use this adapter. Single-writer backup stays available through
`lore replicate ...` and `lore sync --replica <url>`; both print a warning because whole-file
replication cannot merge concurrent writers.

### Session start (MCP initialize)

When a remote is configured and `auto_sync` is on (the default; `auto_sync: false` in `.lore.yml`
or `LORE_AUTO_SYNC=0` disables it), the MCP server answers `initialize` first and pulls the delta
in the background. A failed pull only logs `auto_sync skipped, working offline`; the handshake and
every tool keep working. `memory_status` reports `remote_behind` (commits and rows), the last
observed remote main and the last error.

### Merge and audit

1. The adapter imports the remote bundle through `importBundle`, which applies the 3-way ladder:
   authority (`T0` > `T1` > `T2` > `T4`), verified over stale, deletion over edit, and contested
   instead of corrupting memory for cardinality-one conflicts.
2. `fastForwardSession` moves `agent/<session>` forward when it is strictly behind main.
3. `SYNC_INCOMING` records the remote tip, counts and merge strategy; `SYNC_OUTGOING` records the
   pushed tip. `LitestreamSyncAdapter` alone flushes WAL (`PRAGMA wal_checkpoint(TRUNCATE)`).

### CLI and MCP usage

```bash
lore remote --hub https://lore.example --token-env LORE_HUB_TOKEN
export LORE_HUB_TOKEN=<token>
lore sync                                 # dispatch on the configured remote
lore sync --replica file:///backup/lore.db  # explicit single-writer backup, warns
```

```json
{ "name": "memory_sync", "arguments": { "author": "agent:claude" } }
```

### Two kinds of freshness

A colleague can fetch memory about code they have not pulled. That is not staleness.

| Axis | Question | Behaviour |
|---|---|---|
| Memory | Is the shared store ahead of my local commits? | `lore fetch`; `status` shows `memory ahead by N commits` |
| Code | Does the evidence hash match the file on this machine? | if not, the claim is **ahead of checkout**, not stale: excluded from default retrieval, shown with a warning, still visible in `blame` |

`--trust-remote` accepts the remote evidence hash when the local file is absent, so a reviewer can read
memory for a branch they do not have.

## Cross-repository memory

A repository can publish a filtered, read-only view of its memory to other repositories through
`lore-hub`. Nothing leaves the origin unless its `lore.policy.yml` says so.

Origin (`infra-repo`):

```yaml
publish:
  default_scope: internal            # the allow list is authoritative
  allow: ["doc:*", "sym:src/services/*"]
  deny: ["env:*", "file:secrets/*"]
  to_repos: ["<app-repo repo_id>"]   # consumers allowed to subscribe; "*" opens to all
  require_trust: canonical
```

Consumer (`app-repo`):

```yaml
links:
  infra-repo:                        # slug used in ext:<slug>/...
    repo_id: "<infra-repo repo_id>"
```

- `lore push` sends the policy only for a maintainer. The hub stores it and filters every external
  payload with the same `publishDecision` helper `lore export --md --filter publish` uses, so a
  denied subject never appears in a pull payload or an export. A token scoped to a repository that
  is not in `to_repos` receives `403`.
- `lore fetch` (or `lore links sync`) refreshes subscriptions. Foreign claims are cached read-only
  under `ext:<slug>/<kind>:<canonical>` with `origin_repo_id` attribution. They never enter the
  local commit graph, `factKey` or tier-1 conflicts, and `memory_write` rejects `ext:` targets.
- External freshness is `external`: origin-verified evidence is never re-hashed against the consumer
  filesystem, and external claims are capped at T2 authority. `search` and `blame` render `[EXT]`.
  Linked repositories are included automatically; `--include-external` opts in without a `links:`
  block.
- External hits may consume at most 25% of the token budget (`externalBudgetShare`) and are ranked
  after local hits, so upstream memory cannot crowd out local memory.
- `lore bundle` stays a full-store owner transfer (backup and air gap). Only the hub external
  endpoint and `lore export --md --filter publish` apply the publish policy.

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
  "rule:*": [maintainers]
  "sym:src/auth/*":     # N-of-M review, also enforced by lore-hub
    roles: [maintainers]
    min_attestations: 2
audit:
  agent: [lore-auditor] # read-only principal, signs attestations
```

Identity is resolved in this order: `LORE_TOKEN` (HMAC-signed by `LORE_TEAM_SECRET`, issued with
`lore identity issue --user <email> --role maintainer|contributor`), then `LORE_OIDC_EMAIL` /
`LORE_OIDC_ROLE` asserted by a trusted launcher, then the local OS user. Local mode allows every
action; team mode requires a token and enforces the policy below.

Tiers listed in the policy without `*` become **gated**: a T1 claim stays a draft until an approver
acts. This is how a machine approver becomes useful — by default T0/T1 auto-promote, so there is
nothing to approve.

Three kinds of approver:

| Approver | Evidence it must attach | Notes |
|---|---|---|
| Human | role from the policy | default |
| Machine | policy version + the rule it applied | only for T0/T1 |
| N-of-M | one human plus one audit attestation | for protected subjects |

Enforcement lives in one function (`requireAction`). Every mutating entry point calls it: CLI `write`,
`supersede`, `rename`, `ingest` (batch subject check), `approve`/`reject`, `resolve` (including
`--auto-semantic`), `redact`, `purge`, `promote`, `wrapup` (fast-forward and three-way),
`gc --purge-tombstones`, dashboard `claim`/`supersede`, and MCP `memory_write` / `memory_approve`.
`protected` subjects are checked on approval as well as write, and approval still enforces the tier rule.
`lore identity issue` requires the admin role once the caller presents an identity; possession of the
signing secret alone can bootstrap the first token. The principal is written into the commit author and
`merge_decision.actor`.

**Attestation is implemented** as `lore attest <claim> --verdict agree|disagree --reason`. It writes a
claim `claim:<id> — attested_by — <verdict>` with authority T2, links it in the `attestation` table, and
refuses to attest a claim written by the same principal.

**Separation of duties:** an audit agent cannot approve its own write.

**Quorum.** A `protected` entry may carry `min_attestations` next to its roles. Approval then needs
that many distinct `agree` attestations from principals other than the claim's author, and the hub
applies the same count to every pushed claim. Unset keeps the role-only behaviour.

## Contributor proposals

With `promote: [maintainers]` a contributor cannot advance `main`, and T3/T4 writes stay local
drafts. `lore push` therefore exports a session branch the contributor is not allowed to publish.
Proposals close that gap without granting write permission on `main`:

```
contributor                         lore-hub                     maintainer
lore write (draft)                  repo_proposals               lore proposals list
lore push --propose  ──────────►    refs/proposals/<user>/<session>   ──► lore review --remote
                                                                     lore proposals approve
                                                                     lore proposals promote ──► main
```

- `lore push --propose` publishes the current `agent/<session>` tip and every staged draft as one
  bundle. It records the hub `main` it was built on and never touches `main`.
- The hub stores proposals in `repo_proposals`, outside the shared commit graph: pulls do not see
  them, and `write:`/`protected:` are applied when the promotion bundle is pushed, not before.
- `lore proposals list [--status open]` shows proposals; `lore review --remote` walks them
  interactively; `lore proposals approve|reject <user>/<session>` records the review decision.
- `lore proposals promote <user>/<session>` requires an approved proposal. It imports the bundle,
  approves the proposal's drafts under the maintainer's identity, merges the branch into `main`
  with the normal ladder, and pushes with the proposal tip as an ancestor check on the hub.
- Provenance survives: claim authors and commit authors stay the contributor's, so `lore blame`
  names the contributor while `merge_decision.actor` and the approval commit name the maintainer.
- MCP agents use `memory_propose` for the same publication step.

`lore resolve` unblocks a diverged push. Before merging, import records
`refs/remotes/origin/main`; if the ladder still conflicts, `mergeTip` writes the conflicts to
`merge_conflict` and exits non-zero naming the subject and predicate. The next push replays the
recorded `resolution` rows, so the merge completes and only then advances the branch.

**When humans only check the UI:** review policy changes and a digest, not every claim.
`lore digest [--days 7]` reports claims added, commits, conflicts resolved, attestations (and
disagreements), machine approvals, redactions and purges. Sampling plus a rollback button is the
control; per-claim review does not scale.

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
