# S12 Handoff & Sprint 13 Horizon

**Document**: `docs/HANDOFF-s12.md`
**Date**: 2026-11-28
**Repository**: `529-studio/lore`
**Charter**: Transition ledger closing Sprint 12 (hub DX, credential store, and self-host bootstrap): branch state, merged deliverables, open work, settled decisions, pitfalls, and Sprint 13 horizon.

---

## 1. Branch & Commit Status

- **Active branch**: `main` (at merge base `f9b558d`)
- **Head commit**: `f9b558d` (`Merge pull request #229 from 529-studio/feat/hub-selfhost-init`)
- **Worktree**: local untracked `.lore.bak/` and local `.gitignore` edit for `INTERVIEW_DEFENSE.md` (outside PRs)
- **Merged in this sprint**: PR #226 (`fix/decouple-hub-team-secret`), PR #227 (`feat/autoload-lore-env`), PR #228 (`feat/auth-credential-store`), PR #229 (`feat/hub-selfhost-init`)

## 2. Merged Deliverables

| PR | Task | Subsystem | Delivered capability |
| :- | :--- | :-------- | :------------------- |
| **#226** | #225 | `cli`, `docs` | `lore join` skips `LORE_TEAM_SECRET` warning on `http`/`hub` remotes while preserving it on `postgres`; `docs/team-mode.md` reorganized with `lore-hub` primary and direct-Postgres as legacy fallback (`scripts/join-smoke.mjs`). |
| **#227** | #222 | `cli`, `mcp`, `ui`, `doctor` | `src/env.ts` auto-loads `LORE_*` from `$XDG_CONFIG_HOME/lore/env` (`~/.config/lore/env`) at startup in CLI, MCP, and UI without overwriting `process.env` (even `""`); `lore doctor` reports `env.file` (`scripts/env-autoload-smoke.mjs`). |
| **#228** | #223 | `auth`, `remotes` | `src/credentials.ts` + `lore auth login|status|logout` stores `0600` per-hub (and optional `--repo`) tokens in `credentials.json`; `hubToken()` resolves `process.env` -> `env` file -> `credentials.json`; `syncLinkedRepos` passes `subscriberRepoId` (`scripts/auth-credentials-smoke.mjs`). |
| **#229** | #224 | `hub`, `deploy` | `deploy/` templates (`docker-compose.yml`, `Dockerfile`, `Caddyfile`, `.env.example`) plus `lore hub init` (`0600` `.env`, Postgres `ensureSchema()`, initial `maintainer` token) (`scripts/hub-init-smoke.mjs`). |

## 3. Open Issues & Backlog

- None (`gh issue list --state open` is empty).

## 4. Settled Architectural Decisions

- **Token resolution order (`SPEC.md` §15)**: `process.env[token_env]` -> `$XDG_CONFIG_HOME/lore/env` (`LORE_*` only, never overwriting explicit env keys) -> `$XDG_CONFIG_HOME/lore/credentials.json` (repo-scoped then hub-scoped).
- **Hub remote authorization**: `lore-hub` (`type: http`/`hub`) remotes never require `LORE_TEAM_SECRET` on client machines; `LORE_TEAM_SECRET` remains restricted to legacy direct-Postgres or local `team_mode: true` without an HTTP hub.
- **External pulls use subscriber identity**: `httpPullExternal(remote, sourceRepoId, subscriberRepoId)` authenticates with the subscriber's `repo_id` token rather than the origin's.

## 5. Pitfalls Encountered

- **`SPEC.md` 25 KB budget ceiling**: `SPEC.md` sits within ~12 bytes of the 25,600-byte `docs:lint` limit; every §15 row addition requires trimming older wording first.
- **`Object.hasOwn(process.env, key)` for env precedence**: Tests pass `LORE_TEAM_SECRET: ''` or `LORE_HUB_TOKEN_DEMO: ''` to clear vars; checking truthiness instead of `Object.hasOwn` would leak `~/.config/lore/env` into isolated tests.
- **Local Postgres on port 5432**: `scripts/hub-init-smoke.mjs` expects CI's `postgres:16-alpine` (`postgres:test`); local macOS Postgres instances with a different password fail the online part of `hub-init:smoke` unless `LORE_TEST_PG_URL` is set.

## 6. Sprint 13 Horizon: next tasks

1. Signed attestations for `min_attestations` quorum — `src/security/attest.ts`, `src/hub/store.ts`
2. GitHub PR comment synchronization for proposals — `.github/actions/lore/`, `src/commands/proposals.ts`
3. Differential delta streaming with zstandard compression for hub sync — `src/remotes/http.ts`, `src/hub/server.ts`
4. Incremental AST semantic indexer for TypeScript/Python/Go — `src/search/ast.ts`, `src/extract/index.ts`
5. Interactive visual memory diff / three-way merge editor in Web UI — `src/ui/server.ts`
6. `lore env` edge-case polish (`KEY= # comment`, unreadable `env` file guard, `env.file` entry in `docs/doctor.md`) — `src/env.ts`, `docs/doctor.md`

## 7. Open Questions For The Human

- Confirm whether Sprint 13 should prioritize signed attestations (`min_attestations` quorum) or GitHub PR comment sync for proposals.
