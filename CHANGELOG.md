# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/).

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

[0.1.0]: https://github.com/529-studio/lore/releases/tag/v0.1.0
