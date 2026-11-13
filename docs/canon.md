# Canon: the trust layer

Lore stores memory and evidence. Canon decides what may be injected into an agent's context and why.
This page covers the trust axis and tier-1 conflicts. Retrieval filtering and `lore explain` arrive
in #87; decay arrives in #88.

## Two axes

| Axis | Column | Values | Owner |
|---|---|---|---|
| Branch membership | `state` | `draft`, `active`, `retracted` | Lore |
| Trust | `trust` | `canonical`, `candidate`, `contested`, `stale`, `retracted` | Canon |

A claim can be active in the branch and still not be trusted. Until #87, retrieval does not filter on
trust; the column and the conflicts are visible in the store.

## Write path

| Situation | Trust |
|---|---|
| Active with a test/file/command hash, or commit evidence | `canonical` |
| Active without evidence, or with an unhashable file | `candidate` |
| Draft (agent inference, human chat, policy gate) | `candidate` |
| Human approval | `canonical` |
| Rejection, redaction, GC | `retracted` |

Every write records provenance: `written_by` (`agent` | `human` | `legacy`), `agent_id`,
`session_id`, `run_id`, and `last_verified_at`.

## Tier-1 conflicts

A tier-1 conflict is deterministic: same `(subject, predicate)`, different object, and the predicate
has `cardinality: one`.

- Both claims become `contested` and `contradictions` increments on each.
- One row is written to `claim_conflict` (tier 1). The claim pair is sorted, so re-observation cannot
  duplicate it.
- `cardinality: many` values coexist and never conflict.
- Drafts do not contest live memory. Approving a draft runs the same check.
- `lore supersede` is an explicit replacement; it does not create a conflict.
- Re-writing the same value is idempotent: no new row, no extra contradiction.

No embeddings and no model are in this path. Resolution is deliberate and lands with #87.

## Migration

Opening a pre-Canon store adds the columns and runs a one-time backfill behind
`meta.canon_backfill_v1`: retracted → `retracted`, drafts → `candidate`, active claims with hashed or
commit evidence → `canonical`, all other active claims → `candidate`. A second open does nothing.

`npm run canon:smoke` proves the backfill, the idempotence and every write-path transition above.
