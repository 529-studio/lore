# Contributing

Thanks for taking the time. This project is small enough that a good issue is as valuable as a patch.

## Before you start

- Read [AGENTS.md](AGENTS.md) — the rules apply to humans and AI agents.
- For anything non-trivial, open an issue first so the approach can be agreed before code exists.
- Security problems go to [SECURITY.md](SECURITY.md), never a public issue.

## Setup

```bash
git clone https://github.com/529-studio/lore.git
cd lore
npm ci
npm run build
npm run smoke
```

Node 22+ is required. `better-sqlite3` ships prebuilt binaries; if your platform is unusual,
`npm rebuild better-sqlite3` needs a C++ toolchain.

## Checks CI runs

```bash
npm run build
npm run typecheck
npm run smoke
npm run mcp:smoke
npm run eval          # uses this checkout as the fixture unless LORE_EVAL_FIXTURES is set
npm run docs:lint
npm run check:public
```

Run all of them before opening a PR. If `eval` is slow on your machine, `--fixtures 1` keeps it short.

## Pull requests

1. Branch from `main`: `feat/*`, `fix/*`, `docs/*`, `chore/*`.
2. Keep the change focused; unrelated refactors belong in their own PR.
3. PR description starts with `Close #<issue-number>` and states how you verified it.
4. Expect a review that asks for evidence, not for more features.

## Releasing

The release checklist lives in [docs/release.md](docs/release.md).

## Decisions and lessons

- A decision that is expensive to reverse gets an ADR: `docs/adr/ADR-<NNN>-<slug>.md`, plus a row in
  [docs/adr/README.md](docs/adr/README.md).
- An expensive mistake gets a lesson: `docs/lessons/L<NN>-<slug>.md` and one row in
  [docs/lessons/INDEX.md](docs/lessons/INDEX.md). One lesson per file; never append to a register.

## License

By contributing you agree your work is licensed under the MIT License (see [LICENSE](LICENSE)).
