#!/usr/bin/env bash
# Smoke test: exercises M0 + M1 on a throwaway repo.
set -euo pipefail

LORE_BIN="$(cd "$(dirname "$0")/.." && pwd)/dist/cli.js"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
git init -q
git config user.email "smoke@lore.local"
git config user.name "smoke"

mkdir -p src
cat > package.json <<'JSON'
{
  "name": "smoke-app",
  "bin": { "smoke": "src/cli.js" },
  "engines": { "node": ">=22" },
  "scripts": { "test": "node test.js" },
  "dependencies": { "zod": "^4.0.0" }
}
JSON

cat > src/cli.js <<'JS'
import { z } from "zod";
const token = process.env.DEMO_TOKEN;
export const schema = z.string().min(1);
JS

cat > README.md <<'MD'
# Smoke

## What it does

## How to run
MD

fail() { echo "FAIL: $1" >&2; exit 1; }
expect_contains() { grep -qF "$2" <<<"$1" || fail "expected to contain: $2"; }

lore() { node "$LORE_BIN" "$@"; }

# --- init + ingest -----------------------------------------------------------
lore init >/dev/null
DRY="$(lore ingest --dry-run)"
expect_contains "$DRY" "pkg:zod"
expect_contains "$DRY" "env:DEMO_TOKEN"
expect_contains "$DRY" "doc:README.md"

lore ingest >/dev/null
STATUS="$(lore status)"
ACTIVE_AFTER_INGEST="$(grep -oE '[0-9]+ active' <<<"$STATUS" | grep -oE '^[0-9]+')"
[ "$ACTIVE_AFTER_INGEST" -ge 8 ] || fail "expected >=8 active claims after ingest, got $ACTIVE_AFTER_INGEST"

# --- idempotency -------------------------------------------------------------
SECOND="$(lore ingest)"
expect_contains "$SECOND" "0 new claims"

# --- draft gating ------------------------------------------------------------
DRAFT="$(lore write --subject env:DEMO_TOKEN --predicate rotated_by --object "ops rotation job" --kind agent --author agent:smoke)"
expect_contains "$DRAFT" "draft"
expect_contains "$(lore status)" "1 draft"

lore approve --all-drafts >/dev/null
expect_contains "$(lore status)" "0 draft"

# --- diff + revert -----------------------------------------------------------
SESSION="$(cat .lore/session)"
BRANCH="agent/$SESSION"
DIFF="$(lore diff main..$BRANCH)"
expect_contains "$DIFF" "added"

TARGET="$(lore log -n 1 | grep -oE '^k_[a-f0-9]+' | head -1)"
lore revert "$TARGET" >/dev/null
AFTER_REVERT="$(lore diff main..$BRANCH | grep -oE '[0-9]+ added' | grep -oE '^[0-9]+')"
[ "$AFTER_REVERT" -lt 100 ] || fail "revert did not reduce active claims"

# revert the revert restores the claim
REVERT_COMMIT="$(lore log -n 1 | grep -oE '^k_[a-f0-9]+' | head -1)"
lore revert "$REVERT_COMMIT" >/dev/null
expect_contains "$(lore diff main..$BRANCH)" "added"

# --- drift -------------------------------------------------------------------
cp src/cli.js .cli.bak
BEFORE_STALE="$(lore status)"
expect_contains "$BEFORE_STALE" "0 (evidence hash"
echo "// drift" >> src/cli.js
expect_contains "$(lore status)" "stale claims"
cp .cli.bak src/cli.js
expect_contains "$(lore status)" "0 (evidence hash"

# --- blame -------------------------------------------------------------------
expect_contains "$(lore blame env:DEMO_TOKEN)" "read_by"
expect_contains "$(lore blame rule:does-not-exist || true)" "no claims"

echo "SMOKE OK — init, ingest, idempotency, draft gating, diff, revert, drift, blame"
