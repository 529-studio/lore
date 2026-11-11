# ADR-003: Session branches plus explicit promote

Status: accepted · 2026-11-11

## Context

Several agents work on one repository. If every write landed on a shared `main`, one agent's bad
inference would silently become everyone's memory.

## Decision

Every session writes to `agent/<session>`. `main` only advances through `lore promote`, which runs the
same 3-way merge and authority ladder as any other merge and records the source branch as the second
parent.

## Consequences

- A new session starts from `main`, so it inherits reviewed memory and nothing else.
- Promotion is a review point: conflicts surface there, not during unrelated work.
- A branch with only drafts has nothing to promote; the error says so.
- Users must remember one extra command. The README's daily workflow makes it the end-of-task step.

## Alternatives considered

- **Auto-merge on write**: no review point, and a conflict would block unrelated work.
- **No branches, one store**: simplest, but removes the only place a human can intervene.
- **Git branches**: memory would be coupled to code branches, which is a different lifecycle.
