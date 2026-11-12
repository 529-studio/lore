# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/).

## [0.1.4] — 2026-11-12

### Added

- Dashboard write UI: Review (approve/reject drafts, approve all), Undo (revert a commit with
  confirmation) and Settings (identity, policy, remote), with a CSRF token and Origin check on every
  write. All actions go through `src/actions.ts`.
- `lore review`: readline review of draft claims (approve, reject with reason, skip, quit), with a
  non-interactive listing when stdin is empty. No dependency added.
- `src/actions.ts`: approve, reject, revert and attest implemented once, with policy checks, and used
  by the CLI (and later by the web UI and desktop shell). `lore reject` is the new command.
- Dashboard demo GIF (`docs/assets/demo-gui.gif`) and `scripts/demo/record-gui.mjs` to regenerate it.
- `lore ui`: read-only dashboard on localhost (health, claims, commits), served by `node:http` with no
  framework and no new dependency. ADR-004 records the decision.
- Non-code entities: sections (`doc:<path>#<slug>`), ADRs (`adr:<NNN>`) and local issues
  (`issue:local:<id>`), extracted from Markdown without a model.
- `lore alias add/list/remove`: explicit, reviewed mapping from a human phrase to an entity; used by
  `blame` and `search`.
- `lore rename <old> <new>`: moves entities and evidence after a file rename, keeps the old path as an
  alias, and records the move in `rename_audit`.
- Machine approvers: a policy tier without `*` gates auto-promotion, and `LORE_MACHINE=1` principals can
  approve only T0/T1.
- `lore attest <claim> --verdict agree|disagree`: an independent review stored as a T2 claim, linked in
  `attestation`, with separation of duties (no self-attestation).
- `lore digest [--days 7]`: claims added, conflicts resolved, attestations and disagreements, machine
  approvals, redactions, purges.
- Team identity and policy: `lore identity issue/show`, HMAC tokens signed with `LORE_TEAM_SECRET`,
  OIDC email assertion from a trusted launcher, and `lore.policy.yml` enforced for approve, resolve,
  redact, purge, promote and MCP `memory_approve`. The principal is recorded in the commit author and
  `merge_decision.actor`.
- `lore.policy.example.yml`.
- Postgres transport: `lore remote --postgres --env LORE_REMOTE_URL` stores the commit bundle in a
  `lore_bundles` table. Push takes a per-repository advisory lock and imports the remote first, so
  concurrent pushes cannot drop commits. `npm run pg:smoke` proves two stores, bidirectional sync and
  concurrent pushes in CI.
- `lore redact` replaces a claim object with `[redacted]`, keeps the id and records an audit row;
  `lore purge --yes` removes the row and its evidence, leaving an audit entry. Redacted claims cannot
  be resurrected by a later write or a merge.
- Team sync without a git host: repository identity in `.lore/config.json`, `lore remote <dir>`,
  `lore fetch`/`push`, and `lore bundle export/import` for air-gapped sharing.
- Freshness is now two axes: a claim observed on newer code than the checkout is reported as
  `ahead-of-checkout` (excluded by default, `--trust-remote` includes it) instead of stale.
- Vietnamese team-mode brief at `docs/i18n/team-mode.vi.md`.
- Secret firewall: `lore write` and `lore ingest` reject secrets in claims, `lore guard [--staged]`
  scans files and staged diffs, `--install` adds a pre-commit hook, and `.loresecretignore` holds
  reviewed exceptions.
- `docs/team-mode.md`: decision brief for the shared backend and permissions work (#15, #16).
- Architecture decision records (`docs/adr/`) for storage, the MCP transport and the branch model,
  plus four lessons from the second audit (L05–L08).
- Eval replays 20 distinct sessions per fixture, records wall time, invocations and token cost per
  session, and runs the fixture's own test suite before and after the revert. See `docs/eval.md`.

## [0.1.3] — 2026-11-11

### Added

- GitHub Action: ingests a pull request, diffs memory against the base branch, and comments what the
  change teaches or invalidates. Base memory is cached by commit SHA.

### Fixed

- `search --as-of` walked only one commit chain, so facts that lived on a sibling branch before a
  merge disappeared. The whole ancestry is now folded and filtered by transaction time.
- The hash cache keyed on size and mtime only, so an edit that preserved both served a stale hash and
  the next `ingest` re-blessed it. The key now includes `ctime_ns`, and `--no-cache` works on
  `search` and `verify` as well as `status`.
- A `file`/`test` claim whose evidence could not be hashed (missing file, symlink escape) was
  promoted to active and never went stale. It stays a draft, and existing hash-less evidence now
  reads as stale.
- `readText` followed symlinks out of the repository; it now resolves inside the root.
- `memory_status.drafts` counted from the branch fold, where drafts never appear, so it was always 0.
- MCP `memory_write` was not transactional; a crash could leave a claim without a commit entry.
- `blame` labelled retracted claims as out-of-branch.

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

[0.2.0]: https://github.com/529-studio/lore/releases/tag/v0.2.0
[0.1.4]: https://github.com/529-studio/lore/releases/tag/v0.1.4
[0.1.3]: https://github.com/529-studio/lore/releases/tag/v0.1.3
[0.1.2]: https://github.com/529-studio/lore/releases/tag/v0.1.2
[0.1.1]: https://github.com/529-studio/lore/releases/tag/v0.1.1
[0.1.0]: https://github.com/529-studio/lore/releases/tag/v0.1.0
