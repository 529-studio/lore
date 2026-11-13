# Canon: the trust layer

Lore stores memory and evidence. Canon decides what may be injected into an agent's context and why.
This page covers the trust axis, tier-1 conflicts, the injection filter and `lore explain`. Decay
arrives in #88.

## Two axes

| Axis | Column | Values | Owner |
|---|---|---|---|
| Branch membership | `state` | `draft`, `active`, `retracted` | Lore |
| Trust | `trust` | `canonical`, `candidate`, `contested`, `stale`, `retracted` | Canon |

A claim can be active in the branch and still not be trusted. Retrieval filters on both axes: the
claim must be active in the branch and canonical. The store keeps every state visible to `explain`.

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

No embeddings and no model are in this path. Resolution is deliberate and lands later.

## Injection

`lore search` and MCP `memory_search` return only claims that are `active AND canonical` in the
caller's branch. `candidate`, `contested`, `stale` and `retracted` are never injected.

A contested fact still produces one warning line, so an agent knows memory is incomplete without
receiving either value:

```
memory contested: env:PM:package_manager — see lore explain
```

The warnings are also in JSON (`warnings`, `contested`) and in the MCP `structuredContent`. Derived
freshness still applies: drifted evidence is excluded unless `--include-stale`, and claims observed on
newer code are excluded unless `--trust-remote`.

## Explain and status

```
lore explain env:PM:package_manager   # subject:predicate
lore explain c_9f2a1b4c               # claim id
lore explain env:PM                   # entity id
lore canon status                     # counts per trust state + unresolved conflicts
```

`explain` answers why a claim is or is not injected: trust and the reason for it, provenance
(`written_by`, agent, session, run), evidence with hashes and ages, confidence and authority,
confirmations/contradictions, the supersede chain and every tier-1 conflict. `--json` returns the
same structure. `lore canon status --json` is the machine-readable form for CI.

## Migration

Opening a pre-Canon store adds the columns and runs a one-time backfill behind
`meta.canon_backfill_v1`: retracted → `retracted`, drafts → `candidate`, active claims with hashed or
commit evidence → `canonical`, all other active claims → `candidate`. A second open does nothing.

`npm run canon:smoke` proves the backfill, the idempotence, every write-path transition above, the
injection filter, `explain` and `canon status`.
