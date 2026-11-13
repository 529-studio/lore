#!/usr/bin/env bash
# Canon demo: memory stops being injected when the repository moves npm -> pnpm.
# Runs the real CLI in a throwaway repository. Requires `npm run build` first.
set -euo pipefail

export NO_COLOR=1
export FORCE_COLOR=0

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLI="$ROOT/dist/cli.js"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [ ! -f "$CLI" ]; then
  echo "build first: npm run build" >&2
  exit 1
fi

cd "$WORK"
git init -q
git config user.email "canon-demo@lore.local"
git config user.name "canon demo"

printf '{"name":"canon-pnpm-demo"}\n' > package.json
printf 'lockfileVersion: 3\n' > package-lock.json
git add -A
git commit -qm "baseline: npm"

lore() { node "$CLI" "$@"; }
step() { printf '\n== %s ==\n' "$1"; }

lore init >/dev/null

step "1. npm memory is canonical and injected"
lore write --subject env:PM --predicate package_manager --object npm --kind file --ref package-lock.json --author human:demo
FIRST="$(lore search package_manager --files package.json)"
grep -q '— npm' <<<"$FIRST" || { echo "npm memory was not injected" >&2; exit 1; }
echo "$FIRST"

step "2. the repository moves to pnpm and the npm lock disappears"
rm package-lock.json
printf 'lockfileVersion: 9\n' > pnpm-lock.yaml

step "3. decay marks the npm claim stale (path disappeared)"
lore canon decay

step "4. the new value is written"
lore write --subject env:PM --predicate package_manager --object pnpm --kind file --ref pnpm-lock.yaml --author human:demo

step "5. search injects only pnpm"
SECOND="$(lore search package_manager --files package.json)"
if grep -q '— npm' <<<"$SECOND"; then
  echo "stale npm memory was injected" >&2
  exit 1
fi
grep -q '— pnpm' <<<"$SECOND" || { echo "pnpm memory was not injected" >&2; exit 1; }
echo "$SECOND"

step "6. explain answers why each side is (not) injected"
lore explain env:PM:package_manager

step "7. canon status and metrics"
lore canon status
lore canon metrics --out "$WORK/canon-metrics.json"

echo
echo "CANON DEMO OK — the npm claim decayed with path-disappeared and was not injected; pnpm was"
