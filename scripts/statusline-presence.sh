#!/usr/bin/env bash
# Reads the daemon's snapshot. Never performs network I/O; runs once a second.
set -uo pipefail

SNAP="${AGENT_PRESENCE_SNAPSHOT:-${XDG_RUNTIME_DIR:-/tmp}/agent-presence.json}"
[[ -r "$SNAP" ]] || exit 0

count=$(grep -o '"human"' "$SNAP" 2>/dev/null | wc -l | tr -d ' ')
[[ "$count" == "0" ]] && exit 0

if [[ "$count" == "1" ]]; then
  who=$(sed -n 's/.*"human":"\([^"]*\)".*/\1/p' "$SNAP" | head -1)
  printf '· %s here' "$who"
else
  printf '· %s agents here' "$count"
fi
