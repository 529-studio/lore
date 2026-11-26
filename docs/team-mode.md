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
read the local store. For shared teams, `lore-hub` replaces direct Postgres access with per-user tokens,
delta sync, and server-side policy — see [hub](hub.md).

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
- **Streaming SQLite replication with Litestream.** For distributed multi-agent swarms and continuous backups,
  `lore replicate` streams SQLite WAL frames in real time to S3, Cloudflare R2, Azure Blob, or GCS without
  locking reads or writes. `lore replicate restore` restores a pristine local SQLite store from the replica.
- **Bi-directional synchronization (`lore sync`, `memory_sync`).** Distributed multi-agent nodes
  synchronize bi-directionally without database lock contention or file corruption: the sync adapter restores
  the remote replica into an isolated scratch DB, reconciles incoming claims via the CRDT 3-way merge
  ladder, fast-forwards the session branch, issues an atomic WAL checkpoint flush (`PRAGMA wal_checkpoint(TRUNCATE)`),
  and writes `SYNC_INCOMING` and `SYNC_OUTGOING` audit logs.

## Joining a clone

A shared repository commits `.lore.yml` at its root:

```yaml
repo_id: 1f0c2f7e-4f0a-4a8f-9f0d-2b6f7c9e1a33
team_mode: true
remote:
  type: postgres
  url_env: LORE_TEAM_DB_URL
extractors: [code, docs]
```

Never put a URL with credentials, a password, or a token in this file. `npm run check:public` rejects
those in any tracked `.lore.yml`.

`lore join` in a fresh clone reads the manifest, initialises `.lore/` with the committed `repo_id`
(never a random UUID), writes the local remote, and fetches the team baseline so `lore search` works
immediately. `url_env` stays an environment-variable name; a `dir` path resolves relative to the
checkout. `--no-fetch` configures the store without pulling.

`team_mode: true` is authoritative: it turns team policy on even when `LORE_TEAM_SECRET` is missing,
and any write then fails closed with an explicit message instead of falling back to a local
maintainer identity. A clone can neither disable team mode locally nor act as a maintainer without
`LORE_TOKEN` or a trusted `LORE_OIDC_EMAIL` assertion.

`lore init` and `lore onboard` in a manifest repo adopt the same `repo_id` and remote. If the local
store already belongs to another `repo_id`, they refuse to continue instead of forking team memory
or overwriting the manifest.

Remote forms: `postgres` with `url_env` (recommended), `hub` with an https URL (served by #194), or
`dir` with a relative path for local/offline sharing. The manifest carries no secrets and no personal
agent configuration.

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

## Bi-directional synchronization workflow

When multiple autonomous agents or distributed nodes run in parallel, continuous streaming replication via Litestream requires safe bi-directional coordination. Modifying or restoring active SQLite database files while other agents hold locks leads to `SQLITE_BUSY` errors or database corruption.

The `LitestreamSyncAdapter` (invoked via `lore sync` in the CLI or `memory_sync` in MCP) coordinates multi-node synchronization in two phases: pull and push.

```
Remote Replica (S3/R2/GCS)
       │  1. Litestream restore into isolated scratch DB
       ▼
Scratch DB (/tmp/lore-sync-pull-*)
       │  2. Build bundle from remote main tip
       ▼
Local Lore DB (.lore/lore.db)
       │  3. CRDT 3-way merge ladder (T0 > T1 > T2 > T4, verified > stale)
       │  4. Fast-forward session branch & log SYNC_INCOMING
       │  5. Unlink scratch DB
       │  6. WAL checkpoint flush: PRAGMA wal_checkpoint(TRUNCATE)
       │  7. Log SYNC_OUTGOING
       ▼
Litestream Replication Stream ──► Remote Replica
```

### 1. Isolated scratch database restore (Pull)
1. **Isolated scratch space**: Creates a unique temporary scratch directory (`/tmp/lore-sync-pull-*`).
2. **Restore**: Invokes Litestream restore to populate `.lore/lore.db` inside the scratch directory directly from the remote replica without touching the live local database file or acquiring local locks.
3. **Bundle extraction**: Opens the scratch database in isolation, retrieves the remote `main` branch tip, and generates an in-memory commit bundle.
4. **Cleanup**: Closes the scratch database and recursively removes the temporary directory.

### 2. CRDT 3-way merge ladder
1. Passes the remote commit bundle to `importBundle` and `mergeTip`.
2. Evaluates claims according to Lore's deterministic merge ladder:
   - Authority precedence: `T0 test` > `T1 file/tool` > `T2 human` > `T4 inference`.
   - Staleness: verified evidence prevails over stale claims.
   - Deletions: retract/delete operations take precedence over edits.
   - Cardinality: single-cardinality conflicts without an authority winner are marked contested rather than corrupting memory.
3. Automatically fast-forwards the agent's current working session branch (`agent/<session>`) so newly merged canonical facts are immediately available for retrieval.

### 3. WAL checkpoint flush (Push)
1. Executes `PRAGMA wal_checkpoint(TRUNCATE)` on the local SQLite connection.
2. Flushes all WAL pages into the database file, ensuring Litestream's replication daemon immediately detects and streams newly committed transactions to the remote replica.

### 4. Audit logging
Every synchronization event is recorded in `agent_action_log` for complete multi-agent traceability:
- **`SYNC_INCOMING`**: Records the sync author (`sync:pull` or agent ID), remote tip commit hash, timestamp, and a JSON payload with entity, claim, and commit counts along with merge strategy (`fast-forward`, `merge`, or `up-to-date`).
- **`SYNC_OUTGOING`**: Records the sync author (`sync:push` or agent ID), local tip commit hash, timestamp, and confirms the WAL checkpoint.

### CLI and MCP usage

CLI invocation:
```bash
lore sync                                 # sync with configured replica URL
lore sync --replica s3://my-bucket/lore   # explicit replica URL
lore sync --author agent:gemini           # attribute sync action
```

MCP invocation (autonomous agent tool):
```json
{
  "name": "memory_sync",
  "arguments": {
    "replica": "s3://my-bucket/lore",
    "author": "agent:claude"
  }
}
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
