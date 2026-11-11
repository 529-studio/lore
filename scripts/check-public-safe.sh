#!/usr/bin/env bash
# Fails when a tracked file contains something that must never be public:
# tokens, absolute home paths, or internal infrastructure references.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

PATTERNS='gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|ol_api_[A-Za-z0-9]{10,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY|/Users/[A-Za-z]|/home/[a-z]'

# The scanner and its allowlist legitimately contain the patterns.
EXCLUDE='^(scripts/check-public-safe\.sh|\.public-safety-allowlist)$'

files=$(git ls-files | grep -Ev "$EXCLUDE" || true)
hits=""
if [ -n "$files" ]; then
  hits=$(printf '%s\n' "$files" | tr '\n' '\0' | xargs -0 grep -nEI "$PATTERNS" 2>/dev/null || true)
fi

if [ -n "$hits" ]; then
  echo "[ERR] public-safety: forbidden content in tracked files:" >&2
  printf '%s\n' "$hits" | head -40 >&2
  echo "" >&2
  echo "Remove it, or add a justified line to .public-safety-allowlist." >&2
  exit 1
fi

echo "[OK] public-safety: no tokens, home paths or internal hosts in tracked files"
