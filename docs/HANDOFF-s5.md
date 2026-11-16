# S5 Handoff & Sprint 6 Horizon

**Document**: `docs/HANDOFF-s5.md`
**Date**: 2026-11-16
**Repository**: `529-studio/lore`
**Charter**: Transition ledger for a fresh conversation: branch state, merged deliverables, open work, settled decisions, pitfalls, and the next sprint's tasks.

---

## 1. Branch & Commit Status

- **Active branch**: `docs/s5-handoff`
- **Head commit**: `9f17348` (`Merge pull request #114 from 529-studio/feat/desktop-repo-switcher-and-loading`)
- **Worktree**: clean
- **Merged in Sprint 5**:
  - PR #90 (`feat(canon): trust axis, provenance and backfill`, Issue #85)
  - PR #91 (`feat(canon): detect tier-1 conflicts on write`, Issue #86)
  - PR #92 (`feat(canon): inject only canonical claims`, Issue #87)
  - PR #98 (`feat(cli): add 'lore setup' and 'lore config' commands for agent MCP wiring`, Issue #93)
  - PR #99 (`feat(ui): redesign dashboard into categorized knowledge hub with graph view and claim editing`, Issue #94)
  - PR #100 (`feat: add opencode agent setup and interactive claim inspector with live code snippets`, Issue #96)
  - PR #103 (`chore(workflow): require merge commits and disallow squash merges`, Issue #101)
  - PR #104 (`feat(ui): add app favicon and brand mark to dashboard`, Issue #102)
  - PR #106 (`feat(ui): interactive graph explorer with node inspector, zoom controls, and active view indicators`, Issue #105)
  - PR #108 (`feat(setup): auto-inject agent memory protocol rules for autonomous zero-touch memory`, Issue #107)
  - PR #110 (`feat: domain invariants and rules extraction, update checker subsystem`, Issue #109)
  - PR #112 (`fix(desktop): stage all production dependencies and verify in isolation`, Issue #111)
  - PR #114 (`feat(desktop): instant startup loading screen, repository badge and folder switcher`, Issue #113)

---

## 2. Merged Deliverables

| PR | Task | Subsystem | Delivered capability |
| :--- | :--- | :-------- | :------------------- |
| **#90** | S5-T1a (#85) | `canon`, `core` | **Trust Axis & Provenance**: Added `trust`, `ttl_days`, and provenance fields; backfilled stores idempotently. |
| **#91** | S5-T1b (#86) | `canon`, `core` | **Tier-1 Conflict Detection**: Active writes on `cardinality: one` mark competing claims contested. |
| **#92** | S5-T1c (#87) | `canon`, `mcp` | **Canonical Inject Filter**: Filtered searches to canonical claims; added `lore explain` and `lore canon status`. |
| **#98** | S5-T2 (#93) | `cli`, `setup` | **Agent MCP Wiring**: Added `lore setup` and `lore config` for Claude Desktop, OpenCode, and Antigravity. |
| **#99** | S5-T3a (#94) | `ui`, `dashboard` | **Knowledge Hub Redesign**: Categorized memory explorer, claim editing modal, filterable tabs. |
| **#100** | S5-T3b (#96) | `ui`, `setup` | **Claim Inspector & Snippets**: Direct file snippet previews with line links and OpenCode agent configuration. |
| **#103** | Governance (#101) | `git`, `ci` | **Merge Commit Enforcement**: Mandated `gh pr merge --merge` across all workflows; prohibited squash. |
| **#104** | Branding (#102) | `ui`, `brand` | **Favicon & Brandmark**: Vector SVG logo and tab favicon across web dashboard and desktop window. |
| **#106** | S5-T4 (#105) | `ui`, `graph` | **Interactive Graph Explorer**: Force-directed SVG ontology graph, node inspector, zoom controls. |
| **#108** | S5-T5 (#107) | `setup`, `rules` | **Autonomous Memory Protocol Rules**: Auto-injected Rule 11 into `AGENTS.md` and `.cursorrules` for zero-touch memory. |
| **#110** | S5-T6 (#109) | `extract`, `cli` | **Domain Invariants & Update Check**: Extracted in-code invariants, ADRs, and lesson guardrails; added update checker. |
| **#112** | S5-T7 (#111) | `desktop`, `build` | **Bundled Runtime Isolation**: Staged all production node dependencies via `npm list`; verified in temp sandbox. |
| **#114** | S5-T8 (#113) | `desktop`, `ui` | **Instant Startup & Repo Switcher**: Sub-100ms branded loading screen, header repo badge, native folder picker dialog. |

---

## 3. Open Issues & Backlog

- All Sprint 5 issues (#84-#89, #93-#96, #101-#102, #105, #107, #109, #111, #113) are closed and merged.
- **Sprint 6 Backlog Candidates**:
  - Remote bi-directional sync adapter (Postgres / Litestream streaming replication for distributed teams).
  - Bi-temporal query parser (`lore search --as-of <date> --recorded-before <date>`).
  - Real-time Server-Sent Events (SSE) updates in UI dashboard on SQLite claim changes.
  - Granular access control and entity ownership policy enforcement in multi-agent environments.
  - Windows installer code-signing automation in GitHub Actions.

---

## 4. Settled Architectural Decisions

- **ADR-005 (Desktop Native Shell)**: Tauri 2 native shell bundles a Node sidecar runtime and loads a local webview UI.
- **Canon Trust Axis**: `trust` (`canonical`, `candidate`, `contested`, `stale`, `retracted`) is separate from branch `state`; core calls Canon via decoupled write hooks.
- **Autonomous Memory Protocol**: AI agents must be given persistent memory rules at repo initialization (`AGENTS.md`) so memory tools are invoked automatically.
- **In-Code Invariants Extraction**: Critical business constraints, ADR outcomes, and lesson guardrails are first-class ontology entities alongside symbols and files.
- **Lesson L09 (Isolated Bundled Runtime)**: Desktop staging scripts must collect all hoisted production dependencies and verify execution in an isolated directory outside the repo tree.
- **Two-Phase Desktop Window Launch**: Window opens instantly with local `index.html` loading screen; navigates asynchronously to sidecar once healthy.

---

## 5. Pitfalls Encountered

- **In-Tree Staging Illusion (L09)**: Running the desktop app bundle within the repository tree concealed missing runtime modules because Node traversed parent directories. Packaging must verify execution in a clean `os.tmpdir()` sandbox.
- **Tauri UI Thread Blocking on Startup**: Setting `WebviewUrl::External(url)` in Tauri `setup` stalled the window presentation while waiting for the sidecar port to open. Solved by mounting `WebviewUrl::App("index.html".into())` immediately and asynchronously navigating once healthy.
- **Freshness Check Event Loop Degradation**: Synchronous git tree and ancestor walks on every `/api/health` call increased dashboard polling latency. Solved by caching git HEAD and ancestor traversals in memory (#95, #97).

---

## 6. Sprint 6 Horizon: next tasks

1. Multi-agent streaming synchronization daemon with Litestream SQLite replication — `src/sync/litestream.ts`
2. Bi-temporal search engine supporting both valid-time and transaction-time — `src/canon/temporal.ts`
3. Server-Sent Events (SSE) live memory event streaming endpoint — `src/ui/server.ts`
4. Interactive graph visual clustering and predicate relationship filtering — `src/ui/server.ts`
5. Windows CI installer signing and artifact publishing pipeline — `.github/workflows/desktop-windows.yml`
6. Granular team member permission rules and token revocation — `src/policy/auth.ts`
7. Automated continuous soak test for parallel MCP tool invocations — `scripts/bench-concurrency.mjs`

---

## 7. Open Questions For The Human

- **Sync Architecture**: Should Sprint 6 implement SQLite WAL streaming via Litestream to Cloudflare R2 / S3, or direct peer-to-peer sync between local Lore daemons?
- **Desktop Release Distribution**: Should desktop installers (macOS DMG, Windows EXE) be distributed via Homebrew Cask and Winget, or attached strictly to GitHub Releases?
