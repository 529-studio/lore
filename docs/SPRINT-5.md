# Sprint 5 — Canon, Knowledge Graph & Desktop Runtime

Sprint goal: Ship the Canon memory trust layer to prevent AI agents from hallucinating outdated or contested facts, overhaul the developer dashboard into an interactive knowledge hub with force-directed graph exploration, auto-inject persistent memory rules into agent environments, extract in-code domain invariants and ADRs into verifiable memory, and harden the native desktop application with instant startup and multi-repo switching.

Capacity: 2 weeks, ~80 planned hours across 13 merged PRs. Correctness and verifiability over convenient shortcuts.

---

## Scope

| # | Title | Why now | Est (h) |
|---|---|---|---|
| 85 | Canon schema, trust axis and backfill | Decouples trust from branch state; prerequisite for contested fact prevention | 8 |
| 86 | Write path tier-1 conflict detection | Detects contradicting writes on single-cardinality predicates before corrupting memory | 7 |
| 87 | Canon canonical-only inject filter | Prevents contested and unverified candidate facts from being injected into agent contexts | 6 |
| 88 | Canon TTL decay and file hash checking | Automatically expires stale memory when source files change or disappear | 6 |
| 89 | Canon outcome metrics and demonstration | Quantifies trust accuracy and measures injection quality | 5 |
| 93 | CLI 'lore setup' and 'lore config' commands | Removes friction for onboarding Claude Desktop, OpenCode, and Antigravity | 6 |
| 94 | UI dashboard redesign into knowledge hub | Transforms flat lists into categorized domain entities with search and edit | 8 |
| 96 | Live claim code snippet inspector | Connects memory claims directly to the source code lines that evidence them | 5 |
| 101 | Merge commit enforcement across workflows | Guarantees non-destructive Git DAG history for multi-agent merge verification | 2 |
| 102 | App favicon and vector branding | Professionalizes web dashboard and desktop window presentation | 2 |
| 105 | Interactive SVG graph explorer | Provides visual exploration of entity relationships and ontology structure | 8 |
| 107 | Agent memory protocol rules auto-injection | Ensures agents automatically read from and write to Lore without user intervention | 5 |
| 109 | Domain invariants and rules extraction | Captures business constraints, ADRs, and lesson guardrails into memory | 6 |
| 111 | Staged desktop dependencies isolation | Fixes missing production dependencies in bundled desktop distribution (L09) | 4 |
| 113 | Instant desktop loading and repo switcher | Eliminates startup blank screen and enables switching projects without restart | 6 |

Total: 84 h across 15 issues.

---

## Out of Scope

- Remote bi-directional sync daemon (Postgres / Litestream streaming replication)
- Bi-temporal dual-clock query parser (`--as-of` and `--recorded-before`)
- Server-Sent Events (SSE) live push updates in UI dashboard
- Cloud-hosted web multi-tenant service or SaaS accounts
- Mobile client applications (iOS / Android)

---

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Conflict detection breaks existing write workloads | Confine tier-1 conflicts to `cardinality: one` predicates; multi-valued predicates remain non-conflicting |
| In-tree testing hides missing bundled node dependencies | Stage dependencies via `npm list` and verify startup in isolated `os.tmpdir()` sandbox (L09) |
| Desktop window blocks while waiting for sidecar port | Open window immediately with local `index.html` loading screen; navigate asynchronously when healthy |
| Polling dashboard degrades git repo performance | Cache HEAD commits and ancestor checks in-memory during freshness verification |

---

## Definition of Done (Sprint)

- All 15 scoped issues closed with PRs merged into `main` via `gh pr merge --merge`.
- `npm run typecheck`, `npm run build`, `npm run smoke`, `npm run canon:smoke`, `npm run mcp:smoke`, `npm run eval` all pass cleanly.
- `npm run check:public` exits 0 with zero secret leaks.
- `npm run docs:lint` passes without warnings across all documentation files.
- Desktop bundle built, packaged into DMG, installed to `/Applications/Lore.app`, and verified running.
- Handoff document `docs/HANDOFF-s5.md` and report `docs/reports/sprint5_report.md` committed.

---

## Commands That Prove the Sprint is Done

```bash
# 1. Verification suite
npm run typecheck
npm run build
npm run check:public
npm run docs:lint
npm run smoke
npm run canon:smoke
npm run mcp:smoke
npm run eval

# 2. Desktop runtime verification
node desktop/scripts/stage.mjs
curl -s http://127.0.0.1:55951/api/health
```
