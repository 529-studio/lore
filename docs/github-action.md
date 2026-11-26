# GitHub Action

The action ingests the repository, compares memory against the base branch, and comments on the pull
request:

> ## Lore memory
>
> This pull request adds **1** claim(s) and removes **0**.
> It invalidates **2** existing claim(s); **1** were taught by a teammate or agent.
>
> <details><summary>Invalidated team claims</summary>
>
> - c_9bebecf6 env:API_URL — read_by (human:alice)
>
> </details>
>
> <details><summary>Other invalidated claims</summary>
>
> - c_9d902dff src/db.ts (lore:ingest)
>
> </details>

It answers the question a reviewer actually has: **what does this change do to what the agent knows?**

## Usage

`.github/workflows/memory.yml`:

```yaml
name: Memory

on:
  pull_request:
    branches: [main]

permissions:
  contents: read
  pull-requests: write

jobs:
  memory:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # the action compares against the base commit

      - uses: 529-studio/lore/.github/actions/lore@v0.4.0
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          base-ref: ${{ github.base_ref }}
          hub-url: ${{ vars.LORE_HUB_URL }}      # optional
          hub-token: ${{ secrets.LORE_HUB_TOKEN }} # required with hub-url
```

The action posts one comment and updates it on later pushes; it never writes to the repository.

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `github-token` | required | token used to create or update the comment |
| `base-ref` | `main` | branch the pull request targets |
| `lore-ref` | `v0.4.0` | Lore ref built from source when `lore-version` is empty |
| `lore-version` | `''` | published npm version to install instead of building |
| `hub-url` | `''` | lore-hub URL; when set the action pulls the team baseline |
| `hub-token` | `''` | hub token, passed as `LORE_HUB_TOKEN`; never commit it |
| `strict` | `false` | fail the check when `status --strict` exits 3 |
| `max-claims` | `15` | maximum items listed per section |

Outputs: `added`, `stale`, `team-stale`.

## How it works

1. Builds the CLI (or installs it from npm) once per run.
2. Builds the base memory in a temporary worktree and promotes it to `main`, so `main` holds what the
   base branch knew. The store is cached by base commit SHA.
3. With `hub-url`, points the base store at the hub and runs `lore fetch`, merging the shared team
   baseline (human and agent claims, not just AST facts).
4. Runs `lore status --json` **before** ingesting, so drift caused by the pull request is visible.
5. Ingests the pull request on `agent/head` and runs `lore diff main..agent/head --json`.
6. Parses both JSON documents, splits invalidated claims into team-authored (`human:` / `agent:`
   authors) and extractor claims, and writes the comment. No human output is scraped or truncated.
7. Posts or updates the comment.

Running `status` before `ingest` matters: `ingest` re-observes changed files and would otherwise
silently resolve the drift the reviewer needs to see.

## Requirements and limits

- `fetch-depth: 0`; a shallow clone cannot resolve the base commit.
- The base memory cache is keyed by base SHA, so a long-lived branch rebuilds when the base moves.
- The hub baseline requires a committed `.lore.yml`: a stable `repo_id` is what ties the checkout to
  the team's shared memory. Without it the hub sees a new repository per run.
- The comment reports added and invalidated claims. Deletions do not exist as an operation: claims
  are retracted, never removed, so "removed" is normally 0.
- The first run works even without a lockfile; the cache simply misses.
- `npm run action:smoke` runs the action's JSON parser against fixtures, so a parsing regression
  fails CI without network access.
