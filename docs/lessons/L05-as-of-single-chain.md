# L05 — Time travel that pruned the walk

**What happened.** `search --as-of` found the newest commit before the instant and folded only that
commit's ancestry. When two branches were merged after the instant, the second branch's facts were
unreachable: the walk started at the merge commit, saw it was newer than the instant, and stopped
instead of continuing into its parents.

**Why it was expensive.** The failure was invisible in a linear history and only appeared around
merges — the exact case the feature exists for. A reviewer asking "what did we believe before this
merge" got a confident, wrong answer.

**Guardrail.** A time-travel query filters commits by timestamp; it never prunes the traversal.
Walk the whole ancestry, then apply only the commits at or before the instant. Test with a fact that
lives on a sibling branch before the merge that joins them.
