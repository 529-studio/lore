# L08 — A feature is not shipped until the tag contains it

**What happened.** The GitHub Action landed after `v0.1.2` was tagged. The docs referenced
`529-studio/lore/.github/actions/lore@v0.1.2`, a path that does not exist at that tag, so the headline
integration was unusable for anyone who followed the documentation.

**Why it was expensive.** Every check passed: CI, smoke, the action itself. The gap was between "merged"
and "released", which no test covered.

**Guardrail.** Documentation may only reference a tag that contains the referenced path. Before
publishing a release, resolve the paths named in the docs against the tag
(`git ls-tree -r --name-only <tag> <path>`). Cut a patch release rather than pointing at a branch.
