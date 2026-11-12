# Templates

Starter ontologies copied into `lore.ontology.yml` by `lore onboard`. They only declare which
predicates may hold several values; they do not create claims.

| Template | Use when |
|---|---|
| `code` | a repository with source files |
| `product` | decisions, ADRs, ownership and customer impact |
| `content` | articles, docs and who owns them |
| `support` | tickets, answers, escalation paths |

`lore onboard --template <name>` picks one explicitly. Existing `lore.ontology.yml` files are never
overwritten.
