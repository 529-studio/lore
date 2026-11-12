# Entities beyond code

Lore started with `path#symbol`, which makes entity resolution free in a code repository. Documents,
decisions and issues need the same determinism without a model in the loop.

## Kinds

| Kind | Format | Source | Claims |
|---|---|---|---|
| Document | `doc:<path>` | any tracked `.md` | `title`, `has_section` |
| Section | `doc:<path>#<slug>` | a `##` heading | `section_title` |
| ADR | `adr:<NNN>` | `ADR-001-*.md`, `adr/*.md`, `docs/adr/*.md` | `title`, `status`, `has_section` |
| Local issue | `issue:local:<id>` | `issues/<id>-*.md`, `docs/issues/<id>-*.md` | `title`, `status` |

Slugs are lowercase, accents removed, punctuation collapsed: `## Refund flow` becomes
`doc:docs/payments.md#refund-flow`. A heading rename produces a new section id; the old one becomes
stale, which is the honest outcome.

Local issue files use a `Status:` line (`open`, `closed`, `blocked`, …). There is no provider API: an
exported issue is just a Markdown file in the repository, so the same rules work offline and in an
internal GitLab or Azure DevOps checkout.

## Aliases

Humans say "refund flow"; the store says `doc:docs/payments.md#refund-flow`.

```bash
lore alias add "refund flow" "doc:docs/payments.md#refund-flow"
lore alias list
lore alias remove "refund flow"
```

Aliases are explicit and reviewed, never inferred from embeddings. They affect two places:

- `lore blame "refund flow"` resolves to the entity and shows its claims.
- `lore search "refund flow"` treats the target as in scope, so the section outranks unrelated text.

## Rename

```bash
git mv docs/guide.md docs/handbook.md
lore rename docs/guide.md docs/handbook.md
```

This moves `doc:`/`file:`/`sym:` entities, rewrites claim subjects and evidence refs, and records
`old_path -> new_path` in `rename_audit`. The old path stays as an alias, so `lore blame docs/guide.md`
still works.

Claim ids are content hashes and are **not** rewritten, for the same reason as redaction: history
references them. The audit row records the move.

## Limits

- No automatic entity discovery from free text; aliases are the bridge, and they are explicit.
- Heading rename is not detected as a rename; it looks like a new section. Use an alias to connect them.
- Issue synchronisation with GitHub/GitLab is out of scope; export to Markdown first.
