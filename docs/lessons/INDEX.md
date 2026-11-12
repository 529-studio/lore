# Lessons index

One row per engineering lesson. Read this instead of loading every file.

| # | Lesson | Mandatory guardrail | File |
|---|---|---|---|
| 1 | Drafts were live in retrieval | A draft must never create a commit entry or appear in an active set; assert it through the public `search` command. | [L01](L01-drafts-are-live.md) |
| 2 | The eval graded itself | A scenario check that can fail while the suite reports PASS is the bug; make internal checks fatal. | [L02](L02-eval-self-validation.md) |
| 3 | Merge parents resurrected rejected claims | A merge commit has two parents, so anything rejected must be retracted explicitly. | [L03](L03-dag-resurrection.md) |
| 4 | The path guard was applied to one call site | When you fix a shared helper, grep every caller before declaring it fixed. | [L04](L04-path-escape-half-fix.md) |
| 5 | Time travel pruned the ancestry walk | Filter commits by timestamp; never prune the traversal. Test across a merge. | [L05](L05-as-of-single-chain.md) |
| 6 | The hash cache trusted mtime alone | Content caches keyed on stat data must include `ctime_ns`, with a bypass. | [L06](L06-cache-mtime-lie.md) |
| 7 | Unhashable evidence counted as evidence | Promotion requires an observed hash; otherwise the claim stays a draft. | [L07](L07-unhashable-evidence.md) |
| 8 | The feature was merged but not in the tag | Docs may only reference a tag that contains the path; verify with `git ls-tree`. | [L08](L08-feature-not-in-tag.md) |
