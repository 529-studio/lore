---
name: Feature request
about: Propose a capability or an improvement
title: "[feat] "
labels: type:feature
---

## Context

Which user or operational problem this addresses, and what happens today without it.

## Technical details

- Components and files that own the change.
- Data model or schema impact.
- Migration concerns for existing `.lore` stores.

## Out of scope

What this issue deliberately does not do, so the PR does not grow.

## Definition of done

- [ ] Observable behaviour, stated as a command a reviewer can run.
- [ ] Assertion added to `scripts/smoke.sh`, `scripts/mcp-smoke.mjs` or `scripts/eval.mjs`.
- [ ] Docs updated (`README.md`, affected `docs/`, `SPEC.md` §15 if deviating).

## Estimate

Hours and expected delivery window. Must cover the sound implementation, not the shortcut.
