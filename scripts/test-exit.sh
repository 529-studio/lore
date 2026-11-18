#!/bin/bash
set -euo pipefail
set +e
LORE_TEAM_SECRET="smoke-team-secret-0123456789" lore identity >/dev/null 2>&1
NO_ID=$?
set -e
echo "NO_ID: $NO_ID"
