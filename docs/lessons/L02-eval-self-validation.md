# L02 — The eval graded itself

**What happened.** The eval harness parsed claim ids with the wrong prefix, so two scenario checks
failed on every fixture. The failures were recorded in `eval-results.json` but never added to the
`failed` list, and the summary printed PASS. The metrics looked excellent because the harness
measured a private SQL reconstruction instead of the real `lore search` command.

**Guardrail.** Internal scenario checks are fail-fatal. Metrics are measured through the product's
own CLI. A metric that can be zero by construction is not a metric.
