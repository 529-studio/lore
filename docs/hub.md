# lore-hub: HTTP sync for teams

`lore-hub` is a stateless HTTPS + MCP front end for team memory. It replaces direct
client-to-Postgres sync, so developers never hold `LORE_DB_PASSWORD` or the team signing secret.

## Server

```bash
export LORE_HUB_DATABASE_URL=postgres://lore@db.internal/lore
export LORE_HUB_ADMIN_TOKEN="$(openssl rand -base64 32)"
lore hub serve --port 8787 --host 127.0.0.1
```

Terminate TLS in front of it (Caddy, nginx, an internal load balancer). The server is stateless: one
Postgres client per request, no sessions, no background workers. Data lives in normalized
per-repository tables (`repos`, `repo_commits`, `repo_claims`, `repo_evidence`, `repo_refs`,
`repo_commit_entries`, `repo_conflicts`, `repo_tombstones`, `repo_attestations`, `repo_proposals`,
`auth_revocations`), each row carrying a global `seq` cursor.

## Tokens

Mint per-user opaque tokens with the admin token; they are stored hashed.

```bash
export LORE_HUB_URL=https://lore.example
lore hub token issue --sub alice@company --role maintainer
lore hub token issue --sub bob@company --role contributor --repo <repo-id>
lore hub token revoke --jti <hash>     # immediate, next request is 401
```

A repository-scoped token is rejected with `403` for any other repository. The admin token can only
be used to issue and revoke tokens; it is not a sync credential by accident.

## Client

```bash
lore remote --hub https://lore.example --token-env LORE_HUB_TOKEN
export LORE_HUB_TOKEN=<token>
lore fetch
lore push
```

You can also place `LORE_HUB_URL` and `LORE_HUB_TOKEN*` variables in `~/.config/lore/env`
(or `$XDG_CONFIG_HOME/lore/env`). Lore auto-loads `LORE_*` entries from that file on startup
whenever they are not already set in `process.env` (explicit environment variables always win), so
GUI IDEs and MCP servers inherit hub credentials without sourcing a shell profile. `lore doctor`
reports the `env.file` status.

Or commit it in `.lore.yml` (URL and env name only, never the token):

```yaml
repo_id: 7f3c9a52-1b6d-4c8e-9a0f-2d4b6c8e0a11
remote:
  type: http
  url: https://lore.example
  token_env: LORE_HUB_TOKEN
```

MCP sessions use the same remote: `memory_sync` dispatches to `HttpSyncAdapter`, and `initialize`
pulls a non-blocking delta when `auto_sync` is enabled.

`fetch` pulls only rows newer than the stored `hub_seq` (repository rows) and `hub_auth_seq`
(revocations) plus the current main, then merges with the normal 3-way ladder. Import records the
observed tip as `refs/remotes/origin/main` before merging; a conflicted merge keeps that ref and
records `merge_conflict` rows so `lore resolve` can unblock the next push. `push` pulls first,
sends commits the hub cannot already have (not ancestors of the server's main) with their entries,
claims and evidence, and includes tombstones. The push is an optimistic CAS on `expected_main`; a
concurrent push returns `409`, and the client imports the peer's commits and retries once.

## Authorization

The server evaluates the repository's `lore.policy.yml`, stored from a maintainer push, against the
token's role and subject:

- only a maintainer may advance `main`; a contributor token pushing a direct promotion gets `403`;
- `write:` and `protected:` rules are enforced on every pushed claim, even if the client has no
  local policy, no team secret, and no environment variables;
- `auth_revocations` is checked on every request, and revocation rows sync to stores like other
  tombstones.

`redact` and `purge` travel as tombstones in both directions, so a pull cannot resurrect a deleted or
redacted claim. A purge push also deletes the claim's `repo_claims`, `repo_evidence`,
`repo_commit_entries`, `repo_conflicts` and `repo_attestations` rows in the same transaction, so the
hub never retains a deleted fact. Attestations travel as rows too (`repo_attestations`), because a
quorum needs the review records even when the attested claim itself is already on the hub.

## CI baseline

The GitHub Action accepts the same hub as optional inputs:

```yaml
- uses: 529-studio/lore/.github/actions/lore@v0.4.0
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    hub-url: ${{ vars.LORE_HUB_URL }}
    hub-token: ${{ secrets.LORE_HUB_TOKEN }}
```

When `hub-url` is set, the action runs `lore remote --hub ...` and `lore fetch` after building the
base memory, so the PR drift report includes human and agent claims stored on the hub. Leave both
inputs empty to keep the action purely local. Set `LORE_HUB_ALLOW_INSECURE=1` only for a loopback
test hub.

## Proposals

A contributor publishes a proposal instead of pushing main:

```bash
lore push --propose                     # refs/proposals/<user>/<session>, drafts included
lore proposals list                    # maintainer view
lore proposals approve bob@team/ses_1  # review decision only
lore proposals promote bob@team/ses_1  # merge into main and advance it
```

Proposals are stored in `repo_proposals` with the review status (`open`, `approved`, `rejected`,
`promoted`) and the published bundle. They are not part of the shared commit graph: a pull never sees
them, and `write:`/`protected:` are evaluated when the promotion bundle is pushed. Promotion
requires an approved proposal, a bundle whose new `main` descends from both the current `main` and
the proposal tip, and a non-draft state for every proposed draft. Claim and commit authors stay the
contributor's, so `lore blame` names the contributor after promotion.

MCP tools: `repo_propose` publishes, `repo_proposals` lists, `repo_pull`/`repo_push` stay the sync
path.

## Quorum

A `protected` rule may require independent review:

```yaml
protected:
  "sym:src/auth/*":
    roles: [maintainers]
    min_attestations: 2
```

The hub counts distinct reviewer tokens (`maintainer` or `auditor`) that submitted an `agree`
attestation for a pushed claim whose subject matches the rule. It requires the attestation claim to
exist in the repository and never counts the claim's own author. Attestation rows submitted by a
contributor token are stored for the record but do not count, so a proposal cannot manufacture its
own quorum. The gate applies to maintainers as well; leaving `min_attestations` out keeps the
role-only behaviour.

## MCP

`POST /mcp` speaks JSON-RPC `initialize` / `tools/list` / `tools/call` with `repo_pull`, `repo_push`,
`repo_propose` and `repo_proposals`, using the same bearer token, so a remote agent host can sync and
propose without the CLI. The REST routes are `POST /v1/repos/:id/{pull,push}` and
`POST /v1/repos/:id/proposals[/list|get|review|promote]`.

## Limits

Plugin loading, agent hosts, UI hosting, billing, and real-time WebSocket/CRDT editing are not part of
the hub. The server trusts Postgres for durability and the fronting proxy for TLS.

A quorum counts submissions by authenticated reviewer tokens, and the `actor` string inside a row is
still client-authored. Treat `min_attestations` as N distinct reviewers vouching through their
tokens, not as a cryptographic proof; signed attestations are the next step.
