# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/).

## [Unreleased]

### Added

- GitHub Action: ingests a pull request, diffs memory against the base branch, and comments what the
  change teaches or invalidates. Base memory is cached by commit SHA.

## [0.1.2] — 2026-11-11

### Added

- Bi-temporal reads: `lore write --valid-from <iso>`, `lore search --as-of <iso>`, and the same
  options over MCP (`memory_write.valid_from`, `memory_search.as_of`). `--as-of` walks the commit DAG
  to the last commit known at that instant, so it answers "what did the agent believe last week",
  not just "what is valid now".
- `blame` shows the validity window (`valid_from`, `valid_to`).
- MCP: every tool now publishes an `outputSchema`, and unknown protocol versions negotiate to
  `2025-06-18` instead of being echoed back.
- Draft GC by session: `lore gc --ttl-sessions 3` retracts drafts nobody reviewed in the last three
  sessions. Sessions are registered by any command; review is recorded by `blame`.
- Hash cache keyed by size and mtime: a second pass over an unchanged repository performs zero
  content reads. `lore status --stats` reports hits/reads, `--no-cache` bypasses it, and `gc` prunes
  entries older than 30 days.

## [0.1.1] — 2026-11-11

### Added

- `lore status --strict` exits 3 when staleness or unresolved conflicts cross a threshold, so CI can
  gate on memory health.
- `lore verify --accept` re-observes a legitimately changed file and stores the new hash instead of
  leaving the claim stale forever.
- `lore supersede <claim>` replaces a claim while keeping the old version in history (`valid_to`).
- `npm run mcp:concurrency` proves four MCP servers writing 100 claims lose nothing.
- Tag-driven release workflow with provenance publishing and an attached tarball.

### Fixed

- `lore export --md` moves stale claims into a `## Needs verification` section instead of shipping
  them as if they were true.
- `lore ingest` no longer scans vendor directories in a repository without a `.gitignore`.
- `lore --version` reports the package version.

## [0.1.0] — 2026-11-11

First public release.

### Added

- Claim model with provenance: `(subject, predicate, object)` + bi-temporal fields + authority tier
  (T0 test, T1 tool-observed, T2 human, T3 human chat, T4 inference) + evidence with content hash.
- Content-addressed claim ids, so the same fact observed by two agents merges instead of duplicating.
- Commit DAG with per-session branches (`agent/<session>`), second parent on merge, `diff` and
  `revert` (including revert of a revert).
- Deterministic extractors: `package.json`, environment variables, imports, HTTP routes,
  compose images/ports, Makefile targets, rule registries, root document headings.
- Staleness: evidence is re-hashed on read; drifted claims are excluded from retrieval, kept in
  `blame`, and marked in `export`.
- Retrieval scoring (anchor, graph proximity, authority, verification recency, text overlap) with a
  token budget and an auditable score breakdown.
- 3-way merge on `(subject, predicate)` with the R2 → R3 → R4 → R5 → R6 ladder; unresolved conflicts
  abort with exit 2 and can be resolved by a human.
- `promote` to merge a session branch into `main`; `gc` to retract aged drafts without deleting rows.
- MCP server over stdio: `memory_search`, `memory_write`, `memory_blame`, `memory_status`,
  `memory_diff`, `memory_approve`, `memory_commit`.
- `export --md` deterministic projection for tools without MCP.
- Eval harness with outcome metrics (stale rate, false-claim rate, conflict rate, revert correctness,
  token savings, time to first useful) and no LLM judge.

### Security

- Evidence paths are resolved with `realpath`, confined to the repository, restricted to regular
  files, and capped at 4 MB.

[0.1.2]: https://github.com/529-studio/lore/releases/tag/v0.1.2
[0.1.1]: https://github.com/529-studio/lore/releases/tag/v0.1.1
[0.1.0]: https://github.com/529-studio/lore/releases/tag/v0.1.0
