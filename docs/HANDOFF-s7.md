# S7 Handoff & Sprint 8 Horizon

**Document**: `docs/HANDOFF-s7.md`
**Date**: 2026-11-22
**Repository**: `529-studio/lore`
**Charter**: Transition ledger for a fresh conversation: branch state, merged deliverables, open work, settled decisions, pitfalls, and the next sprint's tasks.

---

## 1. Branch & Commit Status

- **Active branch**: `main`
- **Head commit**: `950348d` (`Merge pull request #144 from 529-studio/fix/ui-script-syntax-and-demo`)
- **Worktree**: clean
- **Merged in Sprint 7**:
  - PR #137 (`feat(trust): add permissive trust mode and solo init preset`, Issue #134)
  - PR #138 (`feat(rules): dynamic agent memory protocol generation and updating`, Issue #135)
  - PR #139 (`feat(session): add session wrapup workflow and status inspection`, Issue #136)
  - PR #142 (`feat(init): smart pre-existing agent detection and one-step onboarding`, Issue #140)
  - PR #143 (`feat(onboard): integrate multi-agent detection and setup in lore onboard`, Issue #141)
  - PR #144 (`fix(ui): eliminate client-side script syntax error and add validation to ui-smoke`)

---

## 2. Merged Deliverables

| PR | Task | Subsystem | Delivered capability |
| :--- | :--- | :-------- | :------------------- |
| **#137** | S7-T1 (#134) | `policy`, `init` | **Solo Dev & Permissive Trust**: `lore init --solo` and `lore config set trust_mode permissive` auto-approves claims in solo environments while recording full audit trails. |
| **#138** | S7-T2 (#135) | `rules`, `cli` | **Dynamic Protocol Snippets**: `lore rules [--update]` injects rich protocol instructions into cursorrules, CLAUDE.md, and AGENTS.md. |
| **#139** | S7-T3 (#136) | `session`, `cli` | **Session Lifecycle & Wrapup**: `lore wrapup [--yes]` and `lore session [status\|rotate]` automate pending reviews, drift audit, and git branch detection. |
| **#142** | S7-T4 (#140) | `init`, `ingest` | **Smart Agent Onboarding**: `lore init --full`, `--setup`, `--rules`, `--ingest` detects pre-existing AI configs (Cursor, Claude, Copilot, Antigravity) without overwriting workflows. |
| **#143** | S7-T5 (#141) | `onboard`, `cli` | **Multi-Agent Setup**: `lore onboard` scans and wires up MCP configs for all discovered agents in a single pass. |
| **#144** | S7-T6 | `ui`, `scripts` | **Client-side Script Integrity**: Eliminated rogue closing brace in Knowledge Hub UI script (`src/ui/server.ts`) and enforced AST syntax parsing in `scripts/ui-smoke.mjs`. |

---

## 3. Open Issues & Backlog

- **Landing Page**: Dedicated conversation is developing the landing page in a separate repository; architectural and deployment plan published to `docs.529studio.site` (Doc ID `c6ee4c7b-3e19-461b-9d99-40dc50a6c607`).
- All planned Sprint 7 core onboarding and UX milestones landed and passed CI.

---

## 4. Settled Architectural Decisions

- **Permissive Trust**: Solo developers can write claims directly to canonical truth without manual review (`trust_mode: permissive`), with non-repudiation preserved via local audit logs.
- **Additive Config Ingestion**: `lore init --full` and `lore onboard` detect pre-existing agent toolings and rules without destructive overwrites, adding lore MCP blocks idempotently.
- **Client Script Smoke Verification**: UI smoke tests (`scripts/ui-smoke.mjs`) must validate inline HTML `<script>` tags using Node.js `node:vm` to fail-fatal on syntax errors before releasing.

---

## 5. Pitfalls Encountered

- **Client Script Syntax Errors**: An extraneous closing brace in inline JavaScript was missed by TypeScript checks because the frontend script was embedded as a template literal string in `src/ui/server.ts`. **Prevention**: `scripts/ui-smoke.mjs` now parses the embedded script via `vm.Script` during every smoke test run.
- **Search Scope in Subdirectories**: CLI `lore search` operates relative to current working directory, not an arbitrary `--root` parameter. Test scripts verifying external paths must pass `{ cwd: targetDir }`.

---

## 6. Sprint 8 Horizon: next tasks

1. Remote bi-directional sync adapter / Litestream streaming — `src/sync/litestream.ts`
2. Bi-temporal search engine and temporal query parser — `src/canon/temporal.ts`
3. Server-Sent Events (SSE) live memory event streaming — `src/ui/server.ts`
4. Interactive graph visual clustering and entity relationship explorer — `src/ui/server.ts`
5. Windows CI installer signing and binary packaging — `.github/workflows/desktop-windows.yml`
6. Concurrency soak benchmark with high-frequency agent workers — `scripts/bench-concurrency.mjs`

---

## 7. Open Questions For The Human

- **Sync Backend Target**: For Sprint 8 task 1 (remote sync), should we default to S3-compatible endpoints (Cloudflare R2 / AWS S3) via Litestream, or prioritize a lightweight HTTP Lore Hub relay server?
