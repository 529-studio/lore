# Lessons index

One row per engineering lesson. Read this instead of loading every file.

| # | Lesson | Mandatory guardrail | File |
|---|---|---|---|
| 1 | Drafts were live in retrieval | A draft must never create a commit entry or appear in an active set; assert it through the public `search` command. | [L01](L01-drafts-are-live.md) |
| 2 | The eval graded itself | A scenario check that can fail while the suite reports PASS is the bug; make internal checks fatal. | [L02](L02-eval-self-validation.md) |
| 3 | Merge parents resurrected rejected claims | A merge commit has two parents, so anything rejected must be retracted explicitly. | [L03](L03-dag-resurrection.md) |
| 4 | The path guard was applied to one call site | When you fix a shared helper, grep every caller before declaring it fixed. | [L04](L04-path-escape-half-fix.md) |
