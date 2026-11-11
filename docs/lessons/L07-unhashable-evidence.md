# L07 — Evidence that could not be observed still counted as evidence

**What happened.** `lore write --kind file --ref missing.ts` stored a claim with `hash = null` and
promoted it to active because the authority tier was T1. Nothing could ever make it stale, so it sat in
retrieval forever. The same path was reachable through MCP.

**Why it was expensive.** It created unfalsifiable memory: claims that look verified and can never be
challenged. A symlink pointing outside the repository produced exactly this shape.

**Guardrail.** Promotion requires an observed hash. If a `file`/`test` evidence ref cannot be hashed,
the claim stays a draft; existing hash-less evidence reads as stale rather than valid.
