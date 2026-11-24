# Plan: Web UI Real-Time Multi-Agent Sync Indicators

**Issue**: [#161](https://github.com/529-studio/lore/issues/161)  
**Charter**: Implement Web UI real-time multi-agent sync indicators in `src/ui/server.ts`.

---

## Task 1: Backend Sync Diagnostics Helper and API Endpoints in `src/ui/server.ts`

- Implement `getSyncStatus(db, root)` extracting active agent sessions, agent branches, remote convergence state, and last sync audit log.
- Expose `GET /api/sync/status` returning the sync status payload.
- Include `sync` object in `GET /api/health` response.
- Add assertions in `scripts/ui-smoke.mjs` verifying `/api/sync/status` and `/api/health` sync payload.

## Task 2: Frontend UI Markup, CSS, and Live Client Updates in `src/ui/server.ts`

- Add `#sync-indicator` HTML with status text and agent count badge to the dashboard header.
- Add CSS styling for `.sync-indicator`, `.sync-dot`, `.agent-badge`, and states (`synced`, `ahead`, `behind`, `diverged`).
- Update client-side `loadHealth()` to render live sync status, agent count, and descriptive tooltips.
- Verify in `scripts/ui-smoke.mjs` checking HTML elements and client-side JavaScript syntax.

## Task 3: Living Documentation & Autonomous PR Lifecycle

- Document Web UI multi-agent sync indicators in `README.md` within 16 KB context budget.
- Add deviation entry in `SPEC.md` §15 within 25 KB context budget.
- Run full verification suite: `npm run docs:lint && npm run build && npm run typecheck && npm run check:public && npm run ui:smoke && npm run smoke`.
- Execute autonomous PR lifecycle: push branch, `gh pr create`, reviewer subagent, await CI checks, merge via `--merge`, checkout `main` and pull.
