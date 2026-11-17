# Implementation Plan: Graph Visual Clustering & Predicate Relationship Filtering

Tracking Issue: [#127](https://github.com/529-studio/lore/issues/127)
Estimate: 3.0h, delivery window: sprint 6 day 1

## Overview
Enhance Lore's graph explorer with semantic domain clustering (Files, External Packages, Environment variables, Governance Rules, Documentation), predicate relationship filtering (`imports_module`, `read_by`, `enforces_invariant`, `exposes_route`, `decides`, etc.), directional arrow markers, and predicate color-coded link edges.

---

### Task 1: Semantic Visual Clustering & Directional Markers (`src/ui/server.ts`)
- Add `clustered: true` to `graphState`.
- Add SVG `<defs>` with directional arrow markers (`arrow-imports`, `arrow-read`, `arrow-invariant`, `arrow-route`, `arrow-default`).
- Define domain cluster centroids:
  - Files / Code Architecture: Center-left
  - External Packages: Bottom-left
  - Environment & Config: Top-right
  - Governance Rules / Invariants: Top-left
  - Documentation / ADRs: Bottom-right
- In force-directed simulation loop, apply cluster gravitational pull toward domain centroid when clustered mode is enabled.
- Color-code SVG link lines by predicate category and attach matching `marker-end` directional arrowhead.
- Add hover `<title>` on links showing `source — [predicate] → target`.

### Task 2: Predicate Relationship Filtering & Toolbar Controls (`src/ui/server.ts`)
- Add `predicateFilter: 'all'` to `graphState`.
- Add `#graph-predicate-select` dropdown in `.graph-toolbar`.
- Add `#graph-cluster-mode` toggle button in `.graph-toolbar`.
- Dynamically populate `#graph-predicate-select` from active predicates.
- Filter claims by selected predicate when `graphState.predicateFilter !== 'all'`.
- Hook change / click events to re-render active graph.

### Task 3: Smoke Test Suite (`scripts/ui-smoke.mjs`)
- Verify presence of `#graph-predicate-select`, `#graph-cluster-mode`, and `<marker id="arrow-imports"` in page HTML.
- Verify that predicate filtering isolates specific relationships correctly.

### Task 4: Documentation & Verification
- Update `README.md` and `SPEC.md` §15.
- Run all checks: `npm run build`, `npm run temporal:smoke`, `node scripts/ui-smoke.mjs`, `npm run smoke`, `npm run check:public`, `npm run docs:lint`.
- Commit, push, open PR with `Close #127`, and merge.
