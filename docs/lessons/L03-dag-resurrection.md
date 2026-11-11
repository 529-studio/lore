# L03 — Merge parents resurrected rejected claims

**What happened.** After commits gained a second parent (the merged branch), a merge decision that
rejected a claim from the other side had no entry of its own. Folding the DAG walked into the second
parent and re-added the claim. "Delete wins over edit" was correct in the decision log and wrong in
the active set.

**Guardrail.** A merge retracts every id that is present on either parent and absent from the final
set. The smoke test asserts the claim is gone from the merged branch, not merely that a decision row
exists.
