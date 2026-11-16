# L09 — In-tree staging masks missing runtime dependencies

**What happened.** The desktop staging script (`desktop/scripts/stage.mjs`) copied only `better-sqlite3` into the bundled runtime's `node_modules`, omitting `commander`, `yaml`, `picocolors`, and `pg`. Testing the staged bundle inside the repository succeeded because Node's module resolution walked up the directory hierarchy to the root `node_modules`. Once packaged into `/Applications/Lore.app` or distributed to users, the app crashed on startup with `ERR_MODULE_NOT_FOUND: Cannot find package 'commander'`.

**Why it was expensive.** The build succeeded in CI, the dmg packaged cleanly, and local manual verification passed because the tester ran the binary within the repo tree where parent `node_modules` existed.

**Guardrail.** Packaging and staging scripts must stage all production dependencies (`npm list --omit=dev --parseable --all`) and verify the staged application by executing it in an isolated temporary directory outside the repository root.
