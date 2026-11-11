# TEAM BRIEF — Lore

Read this before writing code. It is the shared context for parallel agents.

## What Lore is

Versioned, verifiable memory for coding agents. A **claim** is
`(subject, predicate, object)` + bi-temporal validity + authority tier + evidence with a content hash.
Claims are immutable and content-addressed; commits form a git-like DAG; each session writes to
`agent/<session>`; merge is 3-way on `(subject, predicate)`.

Authoritative design: `SPEC.md`. Read §4 (model), §6 (write path), §7 (merge), §8 (staleness),
§9 (retrieval), §10 (interfaces), §11 (eval), §12 (milestones).

## Where we are

| Milestone | State |
|---|---|
| M0 skeleton (init, write, ingest, log, blame, status) | done |
| M1 (diff, revert) | done |
| M2 (3-way merge, R1–R6 ladder, resolve) | done |
| M3 (verify, retrieval scoring, stale-aware search) | **this wave** |
| M4 (MCP server, markdown projection) | next wave |
| M5 (eval harness) | **this wave** |

## Code map

```
src/db.ts               openDb(root), createDb(root), requireRoot(), findStateRoot()
src/schema.ts           SCHEMA (idempotent, executed on every open), ONTOLOGY_TEMPLATE
src/model.ts            upsertClaim, makeCommit, activeAt, head, resolveHead, claimsFor,
                        evidenceFor, authorityOf, fileHash, ClaimRow
src/merge.ts            byKey, isStale, lca, planMerge
src/ontology.ts         loadOntology(root) -> { cardinality(pred), known(pred) }
src/revision.ts         resolveRevision(db, spec), parseRange
src/extract/index.ts    extractAll(root), listFiles(root), hashFile(root, rel)
src/session.ts          currentSession(root), branchFor(session), getMeta/setMeta
src/commands/*.ts       one exported <name>Command(opts) per file
src/cli.ts              commander wiring; every command must be registered here
scripts/smoke.sh        end-to-end test on a throwaway repo
```

## Conventions

- ESM + NodeNext: **relative imports must end in `.js`** (e.g. `./model.js`).
- TypeScript strict. No `any` unless unavoidable.
- No new runtime dependency without a one-line justification in the commit message.
- User-facing CLI output: `picocolors`, terse, aligned. Vietnamese is fine for hints.
- Comments in English.
- Never break existing command names/flags.
- Do not edit `SPEC.md`, `docs/lore-plan.md`, or `README.md` — the coordinator updates docs.
- Do not touch `package.json` version.

## Definition of done (every agent)

1. `npm run build` → clean.
2. `npm run smoke` → passes (extend it if you add behavior).
3. New code has at least one assertion in `scripts/smoke.sh` or a dedicated script.
4. Commit inside your worktree with a conventional message (`feat:`, `fix:`, `test:`).
5. Final report: files changed, commands run, what passed, what is NOT done, known risks.

## Testing against real repos (allowed, read-only)

Good fixtures are small-to-medium repositories with a mix of code and docs: a TypeScript CLI,
a Next.js app with a backend, and a larger Python service. Rules:

- **Never write inside those repos.** Copy to `mktemp -d` first.
- `rm -rf .lore` only inside your copy or your worktree.

## Contracts between agents

M3 exposes (M4 will import it):

```ts
// src/retrieval.ts
export interface SearchOptions {
  query?: string;
  files?: string[];      // paths in scope
  symbols?: string[];    // entity ids in scope
  budgetTokens?: number; // default 2000
  includeStale?: boolean;
}
export interface SearchHit {
  claim: ClaimRow;
  score: number;
  reasons: string[];     // human-readable scoring breakdown
  stale: boolean;
}
export function searchClaims(db: DB, root: string, opts: SearchOptions): SearchHit[];
```

M3 also exposes `verifyClaim(db, root, claimId): { ok: boolean; checked: number; stale: string[] }`
and writes evidence status back to the DB.
