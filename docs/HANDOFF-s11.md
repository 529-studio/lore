# S11 Handoff & Sprint 12 Horizon

**Document**: `docs/HANDOFF-s11.md`
**Date**: 2026-11-26
**Repository**: `529-studio/lore`
**Charter**: Transition ledger closing Sprint 11 (team readiness + signal quality): branch state, merged deliverables, settled decisions, pitfalls, open risks, and the next horizon.

---

## 1. Branch & Commit Status

- **Active branch**: `main`
- **Head commit**: `a85022d` (`Merge pull request #215 from 529-studio/feat/cross-repo-memory`)
- **Worktree**: clean (one pre-existing local `package-lock.json` edit, not committed)
- **Open issues**: zero. **Open PRs**: #188 only, a stale duplicate of the monorepo extractor work delivered in #209; superseded, not merged.
- **Merged in Sprint 11**: PRs #199, #201-#215 (16 PRs), closing issues #178, #181-#184 and #189-#200 (issue #189 was split into #198 tombstone propagation and #200 write authorization).

---

## 2. Merged Deliverables

| PR | Issue | Subsystem | Delivered capability |
| :--- | :--- | :-------- | :------------------- |
| **#199** | #198 | `sync`, `security` | Bundle carries `redactions`, `purge_audits`, `token_revocations`, `attestations`; import applies purge tombstones before rebuild, overwrites redacted `object_json`, scrubs action logs; tombstone race and revocation import hardened. |
| **#201** | #200 | `policy`, `mcp`, `cli` | `requireAction`/`protected` enforced on every write and lifecycle entry point (MCP `toolWrite`/`toolApprove`, `supersede`, `resolve --auto-semantic`, `wrapup` fast-forward, `gc --purge-tombstones`, `identity issue`). |
| **#203** | #178 | `onboarding`, `cli` | Initial ingest baseline is promoted to `main`; stack detection fixed so agents do not start from an empty `main`. |
| **#202** | #190 | `core`, `db` | Store shared across linked git worktrees: `workspaceRoot` vs `stateDir` resolved, isolated mode opt-out, fail-closed when the primary checkout is unknowable. |
| **#204** | #191 | `cli`, `manifest` | Tracked `.lore.yml` manifest plus `lore join` (one-command clone adoption, repo-id mismatch and secret rejection). |
| **#205** | #189 | `policy` | Declared team mode fails closed when `LORE_TEAM_SECRET`/credentials are absent. |
| **#206** | #192 | `core`, `plugins` | `LorePlugin` interface for personal hosts, orchestrators and repo extractors; strict scope rejection, deterministic ingest. |
| **#207** | #194 | `hub` | `lore-hub`: stateless HTTP + MCP sync server, normalized Postgres schema, per-user tokens, server-side policy, delta pull/push with CAS `409` retry, tombstone revocation, `403` for contributors advancing `main`. |
| **#208** | #181 | `status`, `retrieval` | Branch-scoped live stale/contested vs store-wide persisted canon; draft GC by real session distance; token-coverage + boundary-anchored phrase ranking. |
| **#209** | #182 | `extract`, `ingest` | Nested manifests (`**/package.json`, `Makefile`, `docker-compose*`), Python deps/imports, `go.mod`; `pkg:` evidence refs hash the actual manifest. |
| **#210** | #183 | `ui` | Server-backed claim search/pagination, collision-culled graph labels + legend, sticky table actions, single SSE with payload dedup, draft origin-branch approval with provenance, in-browser repo switch, Conflicts tab with `ours`/`theirs`/`both`. |
| **#211** | #195 | `hub`, `team` | Proposal refs `refs/proposals/<user>/<session>`, `lore push --propose`, `memory_propose`, `lore proposals list|approve|reject|promote`, `lore review --remote`, `refs/remotes/origin/main` + resolution replay, optional `min_attestations` quorum. |
| **#212** | #193 | `retrieval`, `extract` | Predicate-class weighting and a query gate so invariants outrank static AST noise; nested `###` rule extraction and dated lessons-log entries; negative-knowledge Recall@5 eval. |
| **#213** | #184 | `cli`, `doctor` | `lore doctor [--json] [--fix]`: store/WAL/schema, branch parity with safe promote, six MCP configs (JSON/JSONC + narrow TOML), ontology/stale/conflict checks, exit 1 on `[ERR]`. |
| **#214** | #196 | `mcp`, `sync`, `ci` | `createSyncAdapter()` dispatches `http`/`postgres`/`dir` (Litestream only for `lore replicate`); MCP auto-sync delta on initialize, `remote_behind`, offline degradation; GitHub Action pulls hub baseline and flags invalidated team claims via `--json`. |
| **#215** | #197 | `hub`, `retrieval`, `policy` | `publish:`/`links:` policy with one shared `publishDecision` (hub + export), `ext:<slug>/` namespacing with `origin_repo_id`, external freshness that is never re-hashed and never outranks local, `[EXT]` rendering, 25% external token cap, `lore export --md --filter`. |

---

## 3. Settled Architectural Decisions

- **Hub is the team sync authority**: `http` remotes over per-user bearer tokens; Postgres is the server's store, never handed to developer machines.
- **Cursor pair, not a global cursor**: `hub_seq` (repo rows) and `hub_auth_seq` (revocations) advance independently; revocation allocation and cursor reads share `pg_advisory_xact_lock('lore_hub_auth')` in a transaction so allocation order equals commit order.
- **Proposals are refs, promotion is policy**: contributors publish `refs/proposals/...`; `write:`/`protected:` are enforced at promotion, not publish. Provenance survives into `lore blame`.
- **One publish decision**: `src/policy/publish.ts` is used by hub external pulls and `lore export --filter`, so server and export cannot disagree.
- **External claims are second-class by construction**: `ext:` ids, `origin_repo_id`, freshness `external` (never re-hashed, max T2, read-only, capped budget share).
- **Signal beats volume**: structural predicates are demoted or excluded from default hits but remain available for proximity; query-matched invariants always precede anchor-only hits.
- **Doctor fails closed**: any `[ERR]` yields a non-zero exit; `--fix` only promotes a single baseline.

---

## 4. Pitfalls Encountered

- **Cursor commit-order race**: a reader could observe `max(seq)` allocated by an uncommitted writer and skip that row forever. **Prevention**: allocate and read cursors under one transaction-scoped advisory lock; return cursors computed inside the transaction.
- **Quorum satisfiable by the client**: `min_attestations` counted attestation rows the contributor could author. **Prevention**: bind quorum to reviewer-issued tokens; signed attestations remain the open follow-up.
- **Stale `refs/remotes/origin/main`**: a sync conflict without a recorded remote ref left `lore resolve` unable to unblock. **Prevention**: record the ref and the conflict before aborting; replay `resolution` rows on the next push.
- **Workers inheriting the coordinator worktree**: one dispatched worker ran `git checkout -b <branch>` in the coordinator's checkout instead of its Orca child worktree, so the coordinator's HEAD moved onto the feature branch. **Prevention**: specs name the branch and forbid `checkout main`/`pull`; verify `git worktree list` before dispatching, and never pull a shared checkout while a worker holds its HEAD.
- **Docs budget ceilings**: `SPEC.md` §15 and `README.md` sit within bytes of their limits, so every PR must trim while appending.

---

## 5. Open Risks

1. `min_attestations` trusts reviewer tokens, not signed attestations; a compromised reviewer token can meet quorum.
2. `write:`/`protected:` are enforced at proposal promotion, so an unreviewed proposal payload is readable by maintainers but not validated on publish.
3. `declared_dependency` keeps `pkg:<name>` across ecosystems, so monorepo version skew still surfaces as a tier-1 conflict.
4. Python dynamic imports (`importlib`) are not extracted.
5. `README.md`/`SPEC.md` are near their context budget; further feature docs need trimming first.

---

## 6. Sprint 12 Horizon

1. Signed attestations for `min_attestations` quorum (`src/security/attest.ts`, hub verification).
2. GitHub PR comment synchronization for proposals (replaces the out-of-scope note in #195).
3. Differential delta streaming with zstandard compression for hub sync.
4. Multi-cluster Raft consensus for distributed hubs (`src/cluster/raft.ts`).
5. Incremental AST semantic indexer for TypeScript/Python/Go (`src/search/ast.ts`).
6. Interactive visual memory diff / three-way merge editor in the Web UI.
