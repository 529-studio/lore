#!/usr/bin/env bash
# Smoke test: exercises M0–M3 on a throwaway repo.
set -euo pipefail

# GitHub Actions sets FORCE_COLOR; assertions compare plain text.
export NO_COLOR=1
export FORCE_COLOR=0

LORE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LORE_BIN="$LORE_ROOT/dist/cli.js"
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
expect_not_contains() { if grep -qF "$2" <<<"$1"; then fail "expected NOT to contain: $2"; fi; }

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
grep -qF "0 new claims" <<<"$SECOND" || fail "second ingest was not idempotent: $(tr '\n' ' | ' <<<"$SECOND")"

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

# --- merge -------------------------------------------------------------------
LORE_SESSION=smoke_a lore write --subject env:DEMO_TOKEN --predicate rotated_by --object "job A" --kind human --ref README.md --author human:alice >/dev/null
LORE_SESSION=smoke_a lore approve --all-drafts >/dev/null
LORE_SESSION=smoke_b lore write --subject env:DEMO_TOKEN --predicate rotated_by --object "job B" --kind human --ref README.md --author human:bob >/dev/null
LORE_SESSION=smoke_b lore approve --all-drafts >/dev/null

set +e
CONFLICT_OUT="$(LORE_SESSION=smoke_a lore merge agent/smoke_b --strict 2>&1)"
CONFLICT_CODE=$?
set -e
[ "$CONFLICT_CODE" -eq 2 ] || fail "expected merge conflict exit 2, got $CONFLICT_CODE"
expect_contains "$CONFLICT_OUT" "ABORT"
expect_contains "$CONFLICT_OUT" "job A"
expect_contains "$CONFLICT_OUT" "job B"

LORE_SESSION=smoke_a lore resolve env:DEMO_TOKEN rotated_by --take theirs --reason "bob owns rotation" >/dev/null
MERGED="$(LORE_SESSION=smoke_a lore merge agent/smoke_b)"
expect_contains "$MERGED" "merged"
expect_contains "$MERGED" "human"

BLAME_MERGE="$(LORE_SESSION=smoke_a lore blame env:DEMO_TOKEN)"
expect_contains "$BLAME_MERGE" "job B"
expect_contains "$BLAME_MERGE" "out-of-branch"

# --- M3: search + verify ------------------------------------------------------
# search operates on the active set of the current branch and honours scope
SEARCH="$(lore search --files src/cli.js,package.json)"
expect_contains "$SEARCH" "env:DEMO_TOKEN"
expect_contains "$SEARCH" "anchor"
expect_contains "$SEARCH" "authority"

JSON_OUT="$(lore search "DEMO_TOKEN" --files src/cli.js --json)"
expect_contains "$JSON_OUT" '"subject": "env:DEMO_TOKEN"'
if ! node -e 'const d=[];process.stdin.on("data",(c)=>d.push(c)).on("end",()=>{JSON.parse(d.join(""));});' <<<"$JSON_OUT"; then
  fail "search --json is not valid JSON"
fi

# drift → stale claims are excluded by default, visible with --include-stale
cp src/cli.js .cli.m3.bak
echo "// drift" >> src/cli.js
expect_not_contains "$(lore search --files src/cli.js)" "read_by"
expect_not_contains "$(lore search --files src/cli.js)" "STALE"
expect_contains "$(lore search --files src/cli.js --include-stale)" "read_by"
expect_contains "$(lore search --files src/cli.js --include-stale)" "STALE"
expect_contains "$(lore export --md)" "Needs verification"

# verify --all --strict exits 3 while a claim is still stale
set +e
lore verify --all --strict >/dev/null 2>&1
STRICT_CODE=$?
set -e
[ "$STRICT_CODE" -eq 3 ] || fail "expected verify --all --strict exit 3 while drifted, got $STRICT_CODE"

# status --strict gates memory health the same way
set +e
lore status --strict >/dev/null 2>&1
STATUS_STRICT=$?
set -e
[ "$STATUS_STRICT" -eq 3 ] || fail "expected status --strict exit 3 while drifted, got $STATUS_STRICT"

# verify --accept re-observes a legitimate change instead of staying stale
ACCEPT_CLAIM="$(lore blame env:DEMO_TOKEN | grep -oE 'c_[a-f0-9]{32}' | head -1)"
expect_contains "$(lore verify "$ACCEPT_CLAIM")" "stale"
expect_contains "$(lore verify "$ACCEPT_CLAIM" --accept)" "valid"
expect_contains "$(lore blame env:DEMO_TOKEN)" "valid"

# restore the file → verify clears the staleness
cp .cli.m3.bak src/cli.js
lore ingest >/dev/null
expect_contains "$(lore verify --all)" "0 stale"
expect_contains "$(lore search --files src/cli.js)" "read_by"
expect_contains "$(lore search --files src/cli.js)" "env:DEMO_TOKEN"
expect_not_contains "$(lore export --md)" "Needs verification"

set +e
lore status --strict >/dev/null 2>&1
STATUS_CLEAN=$?
set -e
[ "$STATUS_CLEAN" -eq 0 ] || fail "expected status --strict exit 0 after restore, got $STATUS_CLEAN"

set +e
lore verify --all --strict >/dev/null 2>&1
CLEAN_CODE=$?
set -e
[ "$CLEAN_CODE" -eq 0 ] || fail "expected verify --all --strict exit 0 after restore, got $CLEAN_CODE"

CLAIM_ID="$(lore blame env:DEMO_TOKEN | grep -oE '\bc_[a-f0-9]{32}' | head -1)"
[ -n "$CLAIM_ID" ] || fail "could not read a claim id from blame"
expect_contains "$(lore verify "$CLAIM_ID")" "valid"

# --- wave 2.5: drafts are invisible to retrieval ----------------------------
DRAFT_ID="$(LORE_SESSION=gate lore write --subject sym:src/cli.js#main --predicate is_hot_path --object "agent inference" --kind agent --author agent:gate | grep -oE 'c_[a-f0-9]{32}' | head -1)"
[ -n "$DRAFT_ID" ] || fail "could not read draft id"
expect_not_contains "$(LORE_SESSION=gate lore search is_hot_path --files src/cli.js --include-stale)" "is_hot_path"
LORE_SESSION=gate lore approve "$DRAFT_ID" >/dev/null
expect_contains "$(LORE_SESSION=gate lore search is_hot_path --files src/cli.js --include-stale)" "is_hot_path"

# --- wave 2.5: promote makes a branch visible to new sessions ---------------
LORE_SESSION=owner lore write --subject env:PROMO_FLAG --predicate read_by --object README.md --kind file --ref README.md --author agent:owner >/dev/null
LORE_SESSION=owner lore promote >/dev/null
expect_contains "$(LORE_SESSION=outsider lore search PROMO_FLAG --files README.md --include-stale)" "env:PROMO_FLAG"

# --- wave 2.5: cardinality=many keeps both values ---------------------------
LORE_SESSION=many_a lore write --subject env:MULTI_FLAG --predicate read_by --object README.md --kind file --ref README.md >/dev/null
LORE_SESSION=many_b lore write --subject env:MULTI_FLAG --predicate read_by --object src/cli.js --kind file --ref src/cli.js >/dev/null
MANY_MERGE="$(LORE_SESSION=many_a lore merge agent/many_b)"
expect_contains "$MANY_MERGE" "merged"
MANY_BLAME="$(LORE_SESSION=many_a lore blame env:MULTI_FLAG)"
expect_contains "$MANY_BLAME" "README.md"
expect_contains "$MANY_BLAME" "src/cli.js"

# --- wave 2.5: retraction after a merge is still visible (real DAG) ----------
B_WRITE="$(LORE_SESSION=many_b lore log -n 1 | grep -oE '^k_[a-f0-9]{32}' | head -1)"
LORE_SESSION=many_b lore revert "$B_WRITE" >/dev/null
LORE_SESSION=many_a lore merge agent/many_b >/dev/null
expect_contains "$(LORE_SESSION=many_a lore blame env:MULTI_FLAG)" "out-of-branch"

# --- wave 2.5: R4 delete vs edit ---------------------------------------------
LORE_SESSION=r4_base lore write --subject env:R4_FLAG --predicate entrypoint --object README.md --kind file --ref README.md >/dev/null
R4_ADD="$(LORE_SESSION=r4_base lore log -n 1 | grep -oE '^k_[a-f0-9]{32}' | head -1)"
LORE_SESSION=r4_base lore promote >/dev/null
LORE_SESSION=r4_del lore revert "$R4_ADD" >/dev/null
LORE_SESSION=r4_edit lore write --subject env:R4_FLAG --predicate entrypoint --object src/cli.js --kind file --ref src/cli.js >/dev/null
R4_MERGE="$(LORE_SESSION=r4_del lore merge agent/r4_edit)"
expect_contains "$R4_MERGE" "retract_wins"
expect_contains "$(LORE_SESSION=r4_del lore blame env:R4_FLAG)" "out-of-branch"

echo "SMOKE OK — init, ingest, idempotency, draft gating, diff, revert, drift, blame, merge, search, verify, promote, cardinality, DAG, retract-wins"

# --- M4: MCP server + markdown projection -------------------------------------
node "$LORE_ROOT/scripts/mcp-smoke.mjs"

lored() { node "$LORE_ROOT/dist/cli.js" "$@"; }
expect_contains "$(lored export --md)" "generated by lore"
expect_contains "$(lored export --md)" "read_by"
expect_contains "$(lored export --md)" "<!-- evidence:"
lored export --md --out AGENTS.md >/dev/null
grep -qF "generated by lore" AGENTS.md || fail "export --out did not write the file"

# --- wave 2.6: path containment, draft GC, health -----------------------------
ESCAPE="$(lore write --subject env:ESCAPE --predicate read_by --object '/etc/passwd' --kind file --ref ../../../../etc/passwd --author agent:escape)"
expect_not_contains "$ESCAPE" "sha256:"

LORE_SESSION=gc lore write --subject env:GC_FLAG --predicate read_by --object README.md --kind agent --author agent:gc >/dev/null
expect_contains "$(LORE_SESSION=gc lore gc --ttl-days 0)" "retracted 1"
expect_contains "$(lore status)" "conflicts"
expect_contains "$(lore status)" "gc"

# --- supersede ---------------------------------------------------------------
SUP_OLD="$(lore write --subject env:SUP_FLAG --predicate read_by --object README.md --kind file --ref README.md | grep -oE 'c_[a-f0-9]{32}' | head -1)"
lore supersede "$SUP_OLD" --object src/cli.js --kind file --ref src/cli.js >/dev/null
SUP_BLAME="$(lore blame env:SUP_FLAG)"
expect_contains "$SUP_BLAME" "src/cli.js"
expect_contains "$SUP_BLAME" "out-of-branch"
expect_contains "$SUP_BLAME" "valid_to"
expect_not_contains "$(lore search SUP_FLAG --files src/cli.js)" "README.md"

echo "SMOKE OK — init, ingest, idempotency, draft gating, diff, revert, drift, blame, merge, search, verify, promote, cardinality, DAG, retract-wins, mcp, export, gc, path-containment, supersede"
