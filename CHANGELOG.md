# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/).

## [Unreleased]

## [0.6.1] — 2026-11-27

Patch release: hub purges now delete rows, and the end-to-end smoke script runs on macOS.

### Fixed

- `lore-hub` push inserted the purge tombstone but kept the purged claim in `repo_claims` and left
  its `repo_evidence`, `repo_commit_entries`, `repo_conflicts` and `repo_attestations` rows, so a
  fresh clone could still pull the deleted fact. All five tables are now swept in the same
  transaction as the tombstone (#220).
- `lore purge` failed with `FOREIGN KEY constraint failed` for any claim the session had read: it
  deleted `commit_entry`, `evidence` and `redaction` but not `claim_read`, and `claim_conflict` had
  the same hole. Both child sets are now removed in the same transaction (#219).
- `lore.ontology.yml` declared only 21 of the 28 extractor predicates, so `section_title`, `title`,
  `status`, `provides_command`, `requires_runtime`, `has_keyword` and `detects` were unknown, doctor
  warned, and re-ingest could not re-derive markdown section claims — obsolete `doc:` claims stayed
  stale permanently. The file now matches `templates/code/lore.ontology.yml` (#219).
- `scripts/smoke.sh` aborted early on macOS with exit `141`: `grep -oE … | head -1` closed the pipe
  while `grep` was still writing, and `set -o pipefail` turned the SIGPIPE into a failure. The
  script now selects the first line with a full-stream reader, and `… | grep -q` assertions were
  replaced by a full-stream `grep -c` helper for the same reason (#220).

### Changed

- Version bumped to 0.6.1, including `serverInfo.version` of both the MCP server and `lore-hub`.

## [0.6.0] — 2026-11-26

Sprint 11: team readiness and signal quality. The hub, proposals and cross-repository memory make a
team's store shareable without handing over the store; ranking and extraction make signal beat
volume.

### Added

- `lore-hub` (#194, #207): stateless HTTP + MCP sync server over a normalized Postgres schema, with
  per-user bearer tokens, server-side policy, delta pull/push with a `409` CAS retry, tombstone
  revocation, and `403` when a contributor tries to advance `main`.
- Team proposals (#195, #211): proposal refs under `refs/proposals/<user>/<session>`,
  `lore push --propose`, MCP `memory_propose`, `lore proposals list|approve|reject|promote`,
  `lore review --remote`, `refs/remotes/origin/main` recording with resolution replay, and an
  optional `min_attestations` quorum bound to reviewer-issued tokens.
- Cross-repository memory (#197, #215): `publish:`/`links:` policy sharing one `publishDecision`
  between hub pulls and `lore export --filter`; `ext:<slug>/` namespaces with `origin_repo_id`;
  read-only external freshness that is never re-hashed and never outranks local claims; `[EXT]`
  rendering; and a 25% external token cap.
- `.lore.yml` manifest and `lore join` (#191, #204): tracked team manifest, one-command clone
  adoption, repository-id mismatch rejection and secret rejection.
- Worktree-shared store (#190, #202): linked git worktrees resolve `workspaceRoot` against
  `stateDir`, isolated mode is an explicit opt-out, and setup fails closed when the primary checkout
  cannot be determined.
- `LorePlugin` (#192, #206): one interface for personal hosts, orchestrators and repository
  extractors, with strict scope rejection and deterministic ingest order.
- `createSyncAdapter()` (#196, #214): dispatches `http`, `postgres` and `dir` remotes (Litestream
  remains for `lore replicate`); MCP auto-syncs a delta on initialize, reports `remote_behind` and
  degrades offline; the GitHub Action pulls the hub baseline and flags invalidated team claims via
  `--json`.
- Polyglot extractors (#182, #209): nested manifests (`**/package.json`, `Makefile`,
  `docker-compose*`), Python dependencies and imports, and `go.mod`; `pkg:` evidence refs hash the
  actual manifest.
- `lore doctor [--json] [--fix]` (#184, #213): one readiness command for store health (path, WAL,
  `quick_check`, required tables and migrated columns), branch parity (`main` empty while an
  `agent/*` branch holds the ingested baseline), agent MCP configs (`.mcp.json`,
  `.agents/mcp_config.json`, `.codex/config.toml`, `.cursor/mcp.json`, `.gemini/settings.json`,
  `opencode.json`), `lore` on `PATH`, extractor predicates in `lore.ontology.yml`, stale claims and
  unresolved conflicts. Malformed JSON/TOML is reported as `[ERR]` with a line number by a narrow
  built-in TOML validator, not a throw. `--json` emits `{ ok, checks }`; exit code is non-zero when
  any check is `[ERR]`. `--fix` only promotes a safe baseline into `main`. `npm run doctor:smoke`
  covers the healthy, broken-TOML and parity-skew scenarios.
- Onboarding baseline (#178, #203): the initial ingest is promoted to `main`, so agents do not start
  from an empty branch.
- Retrieval signal (#181, #208, #193, #212): token-coverage and boundary-anchored phrase ranking;
  predicate-class weighting and a query gate so invariants outrank static AST noise; nested `###`
  rule extraction and dated lessons-log entries; negative-knowledge Recall@5 eval.

### Changed

- Dashboard (#183, #210): `/api/claims` supports server-backed `q` and `offset` pagination with a
  `total`; draft approvals and rejections commit on the draft's origin branch; one SSE connection
  with payload-deduplicated refreshes; collision-culled graph labels and cluster badges; a sticky
  Raw Table action column; an in-browser Switch Repo modal; and a Conflicts tab that compares
  `ours`/`theirs`/`both` through the canon resolve and merge planning paths.
- Status (#181, #208): branch-scoped live stale/contested counts are reported separately from
  store-wide persisted canon, and draft GC measures real session distance.
- Version bumped to 0.6.0 for the team-readiness release.

### Fixed

- Sync tombstones (#198, #199): the bundle carries `redactions`, `purge_audits`, `token_revocations`
  and `attestations`; import applies purge tombstones before the rebuild, overwrites redacted
  `object_json` and scrubs action logs; tombstone races and revocation import are hardened.
- Policy enforcement (#200, #201): `requireAction`/`protected` are enforced on every write and
  lifecycle entry point (MCP `toolWrite`/`toolApprove`, `supersede`, `resolve --auto-semantic`,
  `wrapup` fast-forward, `gc --purge-tombstones`, `identity issue`).
- Team mode (#189, #205): a declared team mode fails closed when `LORE_TEAM_SECRET` or credentials
  are absent.

## [0.5.0] — 2026-11-13

### Added

- Canon trust axis (#85): `claim` gains `trust`, `ttl_days`, `last_verified_at`, `confirmations`,
  `contradictions`, `invalidated_by_json`, `written_by`, `agent_id`, `session_id`, `run_id` and
  `tags_json`. `trust` is separate from branch `state`. Existing stores are backfilled once:
  retracted → retracted, drafts → candidate, active claims with hashed or commit evidence →
  canonical. Writes record their provenance, and approve/reject/GC/redact keep the axis in sync.
  `npm run canon:smoke` proves the migration, the backfill and its idempotence.
- Canon tier-1 conflicts (#86): an active write that contradicts another live claim on a
  `cardinality: one` predicate marks both `contested`, increments `contradictions` and records one
  deduplicated row in `claim_conflict`. Many-valued predicates coexist; drafts are checked on
  approval; supersede is replacement, not conflict; re-writing the same value is idempotent. The
  write path reaches Canon through a registered hook, so core never imports `src/canon/`.
- Canon injection filter (#87): `lore search` and MCP `memory_search` inject only `active AND
  canonical` claims. A contested fact is withheld and reported as a warning line
  (`memory contested: subject:predicate — see lore explain`) in text, JSON and MCP
  `structuredContent`. New `lore explain <claim-id | subject:predicate | entity>` shows trust and why,
  provenance, evidence hashes and ages, confidence, counters, supersede chain and conflicts, with
  `--json`. New `lore canon status [--json]` counts each trust state and unresolved tier-1 conflicts.
- Canon decay (#88): `ttl_days` (null by default), lazy read-path checks for expired TTL and
  disappeared evidence paths, and `lore canon decay [--dry-run]` to persist `trust = stale` with the
  trigger in `invalidated_by_json`. `lore canon confirm <claim>` adds human evidence and restores
  trust; `lore verify --accept` restores it after accepting a new hash. `--include-stale` shows the
  persisted stale rows. A non-ancestor commit stays `ahead-of-checkout`, not stale.
- Canon metrics and demo (#89): `lore canon metrics [--json] [--out <file>]` reports stale injection
  rate, tier-1 conflict precision, explain coverage, candidate-to-canonical median time and
  first-try failure rate, and writes `canon-metrics.json`. `scripts/demo/canon-pnpm.sh` runs the npm
  to pnpm transition end to end: the old claim decays with `path-disappeared` and is no longer
  injected.
- Canon conflict resolution: `lore canon resolve <subject:predicate> --keep <claim-id>` keeps one
  value, retracts its competitors, closes the conflict and records a human evidence row. Retracting,
  redacting or purging one side also closes its open conflicts and restores the survivor when no
  other conflict remains.

### Fixed

- Sync merges trust for claims that already exist in the receiving store instead of ignoring the
  incoming row. A conflict or retraction can no longer be silently undone by `fetch`/`push`; conflict
  resolution flags propagate as well.
- Claim text is escaped in `search`, `explain`, `blame`, `export` and MCP text output, so a newline in
  an object cannot forge a warning line.
- MCP `memory_write` rejects a negative or non-finite `ttl_days`.
- `lore export --md` keeps only canonical claims inline; candidate, contested, stale-trust and
  retracted claims are listed under `Withheld by Canon` without their object, so the projection is
  not a second injection path.
- Version bumped to 0.5.0 for the Canon release.

## [0.4.0] — 2026-11-12

### Added

- `lore onboard`: detects the stack, copies a starter ontology (`code`, `product`, `content`,
  `support`), runs the first ingest and prints the agent-connection and dashboard commands.
- `templates/` with four starter ontologies, shipped in the npm package.
- Windows x64 installer: the Desktop workflow builds an NSIS `.exe` on `windows-2022` and attaches it
  to the release (`Lore_0.4.0_x64-setup.exe`). Unsigned; SmartScreen instructions in
  `docs/desktop.md`. Not yet launched on a real Windows machine.

## [0.3.0] — 2026-11-12

### Added

- macOS desktop app: Tauri v2 shell that bundles the Node runtime, the CLI and better-sqlite3, so the
  `.dmg` installs offline with no Node dependency. Ad-hoc signed; Gatekeeper instructions in
  `docs/desktop.md`. Built by `desktop/` and the `Desktop` workflow on tags.
- Dashboard write UI: Review (approve/reject drafts, approve all), Undo (revert a commit with
  confirmation) and Settings (identity, policy, remote), with a CSRF token and Origin check on every
  write. All actions go through `src/actions.ts`.
- `lore review`: readline review of draft claims (approve, reject with reason, skip, quit), with a
  non-interactive listing when stdin is empty. No dependency added.
- `src/actions.ts`: approve, reject, revert and attest implemented once, with policy checks, and used
  by the CLI, the web UI and the desktop shell. `lore reject` is the new command.
- `lore ui`: local dashboard (health, claims, commits, review, undo, settings) served by `node:http`
  with no framework and no new dependency. ADR-004 records the decision.
- Dashboard demo GIF (`docs/assets/demo-gui.gif`) and `scripts/demo/record-gui.mjs` to regenerate it.
- Non-code entities: sections (`doc:<path>#<slug>`), ADRs (`adr:<NNN>`) and local issues
  (`issue:local:<id>`), extracted from Markdown without a model.
- `lore alias add/list/remove`: explicit, reviewed mapping from a human phrase to an entity; used by
  `blame` and `search`.
- `lore rename <old> <new>`: moves entities and evidence after a file rename, keeps the old path as an
  alias, and records the move in `rename_audit`.

## [0.2.0] — 2026-11-12

### Added

- Team identity and policy: `lore identity issue/show`, HMAC tokens signed with `LORE_TEAM_SECRET`,
  OIDC email assertion from a trusted launcher, and `lore.policy.yml` enforced for approve, resolve,
  redact, purge, promote and MCP `memory_approve`. The principal is recorded in the commit author and
  `merge_decision.actor`.
- `lore.policy.example.yml`.
- Machine approvers: a policy tier without `*` gates auto-promotion, and `LORE_MACHINE=1` principals can
  approve only T0/T1.
- `lore attest <claim> --verdict agree|disagree`: an independent review stored as a T2 claim, linked in
  `attestation`, with separation of duties (no self-attestation).
- `lore digest [--days 7]`: claims added, conflicts resolved, attestations and disagreements, machine
  approvals, redactions, purges.
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

## [0.1.4] — 2026-11-12

### Added

- Eval replays 20 distinct sessions per fixture, records wall time, invocations and token cost per
  session, and runs the fixture's own test suite before and after the revert. See `docs/eval.md`.
- Architecture decision records (`docs/adr/`) for storage, the MCP transport and the branch model,
  plus four lessons from the second audit (L05–L08).

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

[0.6.1]: https://github.com/529-studio/lore/releases/tag/v0.6.1
[0.6.0]: https://github.com/529-studio/lore/releases/tag/v0.6.0
[0.5.0]: https://github.com/529-studio/lore/releases/tag/v0.5.0
[0.2.0]: https://github.com/529-studio/lore/releases/tag/v0.2.0
[0.4.0]: https://github.com/529-studio/lore/releases/tag/v0.4.0
[0.3.0]: https://github.com/529-studio/lore/releases/tag/v0.3.0
[0.2.0]: https://github.com/529-studio/lore/releases/tag/v0.2.0
[0.1.4]: https://github.com/529-studio/lore/releases/tag/v0.1.4
[0.1.3]: https://github.com/529-studio/lore/releases/tag/v0.1.3
[0.1.2]: https://github.com/529-studio/lore/releases/tag/v0.1.2
[0.1.1]: https://github.com/529-studio/lore/releases/tag/v0.1.1
[0.1.0]: https://github.com/529-studio/lore/releases/tag/v0.1.0
