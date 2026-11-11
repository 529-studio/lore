# ADR-001: SQLite with content-addressed claims

Status: accepted · 2026-11-11

## Context

Memory must travel with a repository, work offline, and survive being copied between machines. It also
has to answer "is this fact the same one another agent observed?" without a central authority.

## Decision

Store memory in a single SQLite file at `.lore/lore.db`, and make a claim's identity the hash of its
content: `c_<sha256(subject, predicate, object, valid_from)>`.

## Consequences

- The store is one file; copying the repo copies the memory. No service to run.
- Two agents observing the same fact produce the same id, so merge is a set operation, not text.
- WAL plus `busy_timeout` supports several local processes (proven by `npm run mcp:concurrency`).
- Team-wide sharing needs a different backend; SQLite is per checkout. Tracked as #15.
- The schema is a migration target: every open runs idempotent `CREATE TABLE IF NOT EXISTS` plus small
  `ALTER TABLE` guards.

## Alternatives considered

- **Postgres first**: better for teams, but it kills "memory travels with the repo" and adds
  operations to a tool that should work offline.
- **Git objects**: git merges text, not `(subject, predicate)` facts. Reimplementing the DAG was
  cheaper than bending git's merge model.
- **Files + JSON**: no transactions, no indexes, and concurrent writers corrupt it.
