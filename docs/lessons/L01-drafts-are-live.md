# L01 — Drafts were live in retrieval

**What happened.** Claims written with `kind: agent` were marked `draft` in the store, but the write
path committed them like any other claim and the read path never filtered on state. A draft was
therefore fully visible to `search` and to `merge`. The eval harness recorded `draftGate: FAIL` on
three fixtures while the run still printed PASS, so nobody noticed for a week.

**Why it was expensive.** The entire trust story of the product is "inference is not trusted until a
human approves it". The bug inverted that story silently.

**Guardrail.** A draft never creates a commit entry and never appears in a branch active set. The
assertion must go through the public command (`lore search`), not through the store, because the
store was where the wrong assumption lived.
