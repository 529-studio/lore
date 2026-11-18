# S6 Handoff & Sprint 7 Horizon

**Document**: `docs/HANDOFF-s6.md`
**Date**: 2026-11-18
**Repository**: `529-studio/lore`
**Charter**: Transition ledger for a fresh conversation.

---

## 1. Branch & Commit Status

- **Active branch**: `feat/policy-granular-permissions-and-token-revocation`
- **Head commit**: `5e6f996` (`feat(auth): implement granular permissions and token revocation`)
- **Worktree**: clean
- **Merged in Sprint 6**:
  - PR #132 (`feat(auth): implement granular permissions and token revocation`, Issue #131)

---

## 2. Merged Deliverables

| PR | Task | Subsystem | Delivered capability |
| :--- | :--- | :-------- | :------------------- |
| **#132** | S6-T6 (#131) | `auth`, `policy` | **Granular Permissions & Token Revocation**: Added policy support, JTI-based revocation registry, and smoke tests. |

---

## 3. Open Issues & Backlog

- Sprint 6 issues are closed and PR #132 is open/awaiting CI.
- **Sprint 7 Backlog Candidates**:
  - Remote bi-directional sync adapter.
  - Bi-temporal query parser.
  - Real-time Server-Sent Events (SSE) updates in UI.
  - Windows installer code-signing automation.

---

## 4. Settled Architectural Decisions

- **Identity Immutability**: Identity tokens are immutable for 30d; JTI-based validation is required for token revocation without re-keying teams.

---

## 5. Pitfalls Encountered

- **JTI Propagation**: Identity resolution in `resolvePrincipal` was missing the `jti` field when using token-based authentication, causing auth smoke test failures. Resolved by ensuring `jti` is propagated from `TokenPayload`.

---

## 6. Sprint 7 Horizon: next tasks

1. Remote bi-directional sync adapter — `src/sync/litestream.ts`
2. Bi-temporal search engine — `src/canon/temporal.ts`
3. Server-Sent Events (SSE) live memory event streaming — `src/ui/server.ts`
4. Interactive graph visual clustering — `src/ui/server.ts`
5. Windows CI installer signing — `.github/workflows/desktop-windows.yml`
6. Automated continuous soak test — `scripts/bench-concurrency.mjs`

---

## 7. Open Questions For The Human

- **CI Monitoring**: Keep an eye on the CI run for PR #132 to ensure the new auth smoke tests are reliable.
