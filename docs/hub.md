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
`repo_commit_entries`, `repo_conflicts`, `repo_tombstones`, `auth_revocations`), each row carrying a
global `seq` cursor.

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

Or commit it in `.lore.yml` (URL and env name only, never the token):

```yaml
repo_id: 7f3c9a52-1b6d-4c8e-9a0f-2d4b6c8e0a11
remote:
  type: http
  url: https://lore.example
  token_env: LORE_HUB_TOKEN
```

`fetch` pulls only rows newer than the stored `hub_seq` plus the current main, then merges with the
normal 3-way ladder. `push` pulls first, sends commits the hub cannot already have (not ancestors of
the server's main) with their entries, claims and evidence, and includes tombstones. The push is an
optimistic CAS on `expected_main`; a concurrent push returns `409`, and the client imports the peer's
commits and retries once.

## Authorization

The server evaluates the repository's `lore.policy.yml`, stored from a maintainer push, against the
token's role and subject:

- only a maintainer may advance `main`; a contributor token pushing a direct promotion gets `403`;
- `write:` and `protected:` rules are enforced on every pushed claim, even if the client has no
  local policy, no team secret, and no environment variables;
- `auth_revocations` is checked on every request, and revocation rows sync to stores like other
  tombstones.

`redact` and `purge` travel as tombstones in both directions, so a pull cannot resurrect a deleted or
redacted claim.

## MCP

`POST /mcp` speaks JSON-RPC `initialize` / `tools/list` / `tools/call` with `repo_pull` and `repo_push`,
using the same bearer token, so a remote agent host can sync without the CLI.

## Limits

Plugin loading, agent hosts, UI hosting, billing, and real-time WebSocket/CRDT editing are not part of
the hub. The server trusts Postgres for durability and the fronting proxy for TLS.
