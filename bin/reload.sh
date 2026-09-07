#!/bin/bash
# Reload the oneterm host after editing server.mjs — safe to run FROM INSIDE a
# oneterm session.
#
# Why this exists: restarting the host drops every WebSocket, including the one
# you are typing in. That is survivable (tmux owns the sessions, the browser
# reconnects), but a SYNTAX ERROR is not: the host would crash-loop, taking the
# web UI with it, and you would have no UI left to fix it from. So check first,
# and refuse to restart a broken file.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-7331}"
LABEL="com.oneterm.host"

echo "checking server.mjs…"
if ! node --check "$DIR/server.mjs"; then
  echo
  echo "✗ server.mjs has a syntax error — NOT restarting."
  echo "  The current host is still running and your sessions are untouched."
  exit 1
fi

# The client script is inlined in index.html, so a broken edit there loads a
# blank page. Cheap to catch here too.
if ! node -e '
  const fs = require("fs")
  const h = fs.readFileSync(process.argv[1], "utf8")
  const m = h.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/)
  if (!m) { console.error("could not find the inline client script"); process.exit(1) }
  new Function(m[1])
' "$DIR/public/index.html"; then
  echo
  echo "✗ public/index.html has a syntax error — NOT restarting."
  exit 1
fi
echo "  both files parse"

OLD_PID=$(curl -sf --max-time 1 "http://127.0.0.1:$PORT/health" 2>/dev/null \
          | sed -n 's/.*"pid":\([0-9]*\).*/\1/p')
SESSIONS_BEFORE=$(tmux ls -F '#{session_name}' 2>/dev/null | grep -c '^oneterm_' || echo 0)

echo "restarting host (was pid ${OLD_PID:-none})…"
launchctl kickstart -k "gui/$UID/$LABEL" >/dev/null 2>&1

for _ in $(seq 1 40); do
  NEW_PID=$(curl -sf --max-time 1 "http://127.0.0.1:$PORT/health" 2>/dev/null \
            | sed -n 's/.*"pid":\([0-9]*\).*/\1/p')
  [ -n "$NEW_PID" ] && [ "$NEW_PID" != "$OLD_PID" ] && break
  sleep 0.25
done

SESSIONS_AFTER=$(tmux ls -F '#{session_name}' 2>/dev/null | grep -c '^oneterm_' || echo 0)

if [ -z "${NEW_PID:-}" ]; then
  echo "✗ host did not come back — check ~/Library/Logs/oneterm/host.err"
  exit 1
fi

echo "✓ host up as pid $NEW_PID"
echo "✓ sessions: $SESSIONS_BEFORE before, $SESSIONS_AFTER after (tmux kept them)"
echo
echo "The browser reconnects on its own. Reload the tab only if you changed index.html."
