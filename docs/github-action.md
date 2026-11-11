# GitHub Action

The action ingests the repository, compares memory against the base branch, and comments on the pull
request:

> ## Lore memory
>
> This pull request adds **1** claim(s) and removes **0**.
> It invalidates **2** existing claim(s).
>
> <details><summary>Invalidated claims</summary>
>
> - c_9bebecf6 src/db.ts
> - c_9d902dff src/db.ts
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

      - uses: 529-studio/lore/.github/actions/lore@v0.1.3
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          base-ref: ${{ github.base_ref }}
```

The action posts one comment and updates it on later pushes; it never writes to the repository.

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `github-token` | required | token used to create or update the comment |
| `base-ref` | `main` | branch the pull request targets |
| `lore-ref` | `v0.1.3` | Lore ref built from source when `lore-version` is empty |
| `lore-version` | `''` | published npm version to install instead of building |
| `strict` | `false` | fail the check when `status --strict` exits 3 |
| `max-claims` | `15` | maximum items listed per section |

Outputs: `added`, `stale`.

## How it works

1. Builds the CLI (or installs it from npm) once per run.
2. Builds the base memory in a temporary worktree and promotes it to `main`, so `main` holds what the
   base branch knew. The store is cached by base commit SHA.
3. Runs `lore status` **before** ingesting, so drift caused by the pull request is visible.
4. Ingests the pull request on `agent/head` and diffs `main..agent/head`.
5. Writes the comment and posts or updates it.

Running `status` before `ingest` matters: `ingest` re-observes changed files and would otherwise
silently resolve the drift the reviewer needs to see.

## Requirements and limits

- `fetch-depth: 0`; a shallow clone cannot resolve the base commit.
- The base memory cache is keyed by base SHA, so a long-lived branch rebuilds when the base moves.
- The comment reports added and invalidated claims. Deletions do not exist as an operation: claims
  are retracted, never removed, so "removed" is normally 0.
- The first run works even without a lockfile; the cache simply misses.
