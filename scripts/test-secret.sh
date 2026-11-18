SECRET="smoke-team-secret-0123456789"
LORE_TEAM_SECRET=$SECRET lore identity >/dev/null 2>&1
echo "Exit: $?"
