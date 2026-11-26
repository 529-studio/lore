# Retrieval and rule extraction

`lore search` ranks claims deterministically inside the default 2,000-token
budget. Vector similarity is an optional tiebreak, never the source of truth.

## What wins the budget

| Predicate class | Predicates | Score |
|---|---|---|
| Invariant | `enforces_invariant`, `defines_rule`, `has_known_bug`, `decides`, `has_constraint`, `has_guardrail` | +3.0 |
| Route | `exposes_route` | +0.75 |
| Structural | `imports_module`, `has_section`, `section_title`, `declared_dependency` | -3.0 |

Structural predicates are demoted, not deleted: an explicit structural query
still returns them, and `imports_module` remains available for the 2-hop
proximity index. They must never fill the budget ahead of a guardrail.

Anchor and proximity describe where a claim lives. With a `query`, they cannot
satisfy relevance by themselves: the claim text must match the query tokens,
the exact phrase, or the semantic threshold. Without a query, scope and
authority rank the active set as before.

The exact-phrase and full-token-coverage precedence from issue #181 is
unchanged: phrase matches sort first, then coverage, then the score above.

## Rule extraction

`lore ingest` extracts rules deterministically (no model calls):

- Numbered `AGENTS.md`/`CLAUDE.md`/`ARCHITECTURE.md`/`CONTRIBUTING.md`/`RULES.md`
  headings (`## 1. ...`) keep their nested `###` subsections up to the next
  heading of the same or a higher level.
- `docs/lessons/LNN-*.md` files keep their guardrail and issue claims.
- Lessons logs (`lessons-learned.md`, `lessons.md`, `learnings.md`,
  `postmortems.md`, `retrospectives.md`, `incidents.md`) are split on dated
  headings. `Problem`/`What happened` becomes `has_known_bug`;
  `Root cause`/`Why it happened`/`Why it was expensive` becomes
  `describes_issue`; `Prevention`/`Guardrail`/`Rule`/`Solution` becomes
  `has_guardrail`. Undated entry bodies fall back to `describes_issue`.
- Rule prose is capped at 1,200 characters, not the old 400-character cut that
  severed the rationale from the rule.

## Evidence

`scripts/eval.mjs` runs the negative-knowledge benchmark: 1,000 static
`imports_module` claims in scope plus 10 operational traps. Each trap query is
asked through the real `lore search` subprocess with the default budget, and
Recall@5 must stay at 100%.
