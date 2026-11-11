# Release process

## One-time setup

1. Create an npm token with publish rights for the `@529studio` scope.
2. Add it to the repository secrets as `NPM_TOKEN`.
3. Without the secret the release job still runs: it builds, verifies, and attaches the
   tarball to the GitHub release, but skips `npm publish`.

## Cutting a release

```bash
# 1. version and changelog
npm version 0.1.1 --no-git-tag-version
# edit CHANGELOG.md: move Unreleased items under the new version

# 2. verify locally
npm run build && npm run typecheck && npm run smoke && npm run mcp:smoke
npm pack --dry-run

# 3. commit and tag
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore(release): 0.1.1"
git tag -a v0.1.1 -m "Lore v0.1.1"
git push origin main --tags
```

The `Release` workflow then:

1. runs the full verification suite,
2. inspects the package contents,
3. publishes to npm when `NPM_TOKEN` exists (with provenance),
4. attaches `529studio-lore-<version>.tgz` to the GitHub release and generates notes.

## What ships

Only `dist/`, `README.md`, `LICENSE` and `package.json` (the `files` field). No sources, no
`.lore` store, no eval artifacts. `npm pack --dry-run` is the check.

## Rollback

An npm version cannot be unpublished after 72 hours. Prefer publishing a patch. A broken
GitHub release can be edited; a broken tag can be moved before the npm publish, never after.
