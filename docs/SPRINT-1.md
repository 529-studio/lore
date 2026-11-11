# Sprint 1 — v0.1.0 public beta

Sprint goal: in two weeks, ship a Lore that any developer can install from npm, trust on a public repo, and gate CI on — released as v0.1.0 with every release blocker closed.

Capacity: 2 weeks, ~64 planned hours of 60-70 budget. Correctness beats features: the sprint buys packaging, proof, and two user-visible fixes, not new surface area.

## Scope

| # | Title | Why now | Est (h) |
|---|---|---|---|
| 12 | Public safety gate: no secrets, no private paths, license, SECURITY.md | Blocks making the repo public; without it everything else is unshippable | 5 |
| 11 | CI: build, smoke, mcp-smoke, eval and secret scan on every PR | Every guarantee in the repo is currently a local script a contributor can forget | 8 |
| 24 | Context budget lint for docs | Cheap (3h) and prevents repeating ProjectKV's 143 KB lesson register | 3 |
| 6 | status --strict: exit 3 when memory health degrades | The tiny hook that makes CI able to gate on memory health; WSJF 6.7, highest of all 24 | 3 |
| 3 | verify: accept a legitimate file change (--accept) | User-visible bug: a legitimately changed file stays stale forever until re-ingest. The sprint's headline correctness fix | 6 |
| 7 | export --md: mark stale claims instead of shipping them silently | User-visible bug: AGENTS.md presents dead facts as truth, the exact failure Lore exists to prevent | 4 |
| 5 | supersede: make the supersedes column real | Core-model gap: competing versions of a fact instead of a chain; prerequisite for bi-temporal reads (#1) | 10 |
| 9 | Concurrency: parallel MCP writers under WAL | Two agents on one repo is the normal case; the audit result must be provable in CI, not anecdata | 5 |
| 10 | Publish to npm: npx lore | "Anyone can use it" means an artifact; v0.1.0 without npx is a branch, not a release | 8 |
| 13 | README for two audiences: developer and non-developer | First-run decides adoption; P0 for the public release | 8 |
| 14 | Release v0.1.0 with notes, tarball and upgrade path | The sprint's terminal deliverable; must land on the last day | 4 |

Total: 64 h across 11 issues. Every P0 issue is included.

## Out of scope

- #1 Bi-temporal reads (P1, next sprint — build on #5)
- #2 GC by session, #4 hashing cache, #8 MCP outputSchema (P2 internals)
- #15 Postgres adapter, #16 auth/permissions, #18 web dashboard, #20 non-code entities, #21 desktop app, #22 onboarding wizard — any new backend, UI or auth surface
- #17 GitHub Action, #19 20-session eval (P1, but neither blocks a correct v0.1.0)
- #23 lessons index and ADR log (P2; valuable, deferred to protect the 60-70 h budget)
- Homebrew, Docker, SSO, hosted anything

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| #10 blocked on npm token or package-name approval | Do it on day 6-7, not day 10; fall back to `npm pack --dry-run` verification and release the tarball via #14 so the sprint still ends shippable |
| #5 touches the merge ladder (R2) and can regress merge behaviour | Smoke suite plus a dedicated supersede-then-merge case; revert the feature commit if the ladder regresses, ship v0.1.0 without it |
| Release day eaten by CI flakes | CI lands on day 1-2, everything after is gated by it; day 9 is a full buffer day, zero new scope |
| Secret scan or history scan finds a real leak late | #12 is the first item, day 1; history scan runs in CI from day 2 onward, so surprises surface immediately, not before the tag |

## Definition of done (sprint)

- All 11 scoped issues closed with their own definition-of-done checked
- `npm run build`, `npm run smoke`, `npm run mcp:smoke`, `npm run eval` all pass locally and in CI
- `scripts/check-public-safe.sh` exits 0 and gitleaks history scan is clean
- `docs/SPRINT-1.md` sized lint (issue #24) passes on every doc
- v0.1.0 tagged, GitHub Release published with tarball, CHANGELOG matches the tag
- No P0 issue left open

## Day-by-day plan

| Day | Work | Hours |
|---|---|---|
| 1 | #12 public safety gate | 5 |
| 2 | #11 CI (finish), #24 docs lint wired into CI | 8 |
| 3 | #6 status --strict, start #3 verify --accept | 5 |
| 4 | #3 finish, #7 export --md stale marking | 5 |
| 5 | #5 supersede (feature branch, smoke first) | 8 |
| 6 | #5 finish, #9 concurrency script | 7 |
| 7 | #9 into CI, #10 npm packaging | 5 |
| 8 | #10 finish (clean-machine npx check), start #13 README | 6 |
| 9 | #13 README finish, #14 release prep (CHANGELOG, tag dry-run) — buffer day, no new scope | 8 |
| 10 | #14 tag v0.1.0, publish release, full verification pass, sprint retro | 3 |

## Commands that prove the sprint is done

```bash
npm run build
npm run smoke
npm run mcp:smoke
npm run eval
bash scripts/check-public-safe.sh
gitleaks detect --log-opts=--all
npm pack                      # contains only dist + metadata
npx @529studio/lore --version # prints 0.1.0 (or verify tarball install)
gh release view v0.1.0 --repo 529-studio/lore   # notes + lore-0.1.0.tgz asset
gh pr status --repo 529-studio/lore             # all checks green on main
```

## Proposed backlog additions

Not created as issues (per process), flagged here for triage:

1. `--strategy recency` is accepted but the ladder stays authority-first (lore-plan §8, open adjustment 5). Either implement it or remove the flag before v0.1.0 to avoid a lying CLI surface.
2. Worst-file stale_rate on doc drift (README/AGENTS.md at 27.8% vs the 15% threshold) is an extractor concentration problem; a doc-claim splitting rule would make the honest eval claim cleaner.
3. MCP concurrency should also cover concurrent read-during-write (search returning a torn active set), not only parallel writes.
