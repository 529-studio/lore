# Templates

Starter ontologies copied into `lore.ontology.yml` by `lore onboard`. They only declare which
predicates may hold several values; they do not create claims.

A predicate may also carry `ttl_days: N`. It is absent by default: only add a TTL when the fact really
goes stale on a clock (a wrong TTL silently removes good memory). `lore write --ttl-days N` overrides
it for one claim.

| Template | Use when |
|---|---|
| `code` | a repository with source files |
| `product` | decisions, ADRs, ownership and customer impact |
| `content` | articles, docs and who owns them |
| `support` | tickets, answers, escalation paths |

`lore onboard --template <name>` picks one explicitly. Existing `lore.ontology.yml` files are never
overwritten.
