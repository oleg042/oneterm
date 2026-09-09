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

# Detection is the part that has broken most often, always the same way: an
# assumption about where Claude Code draws something, never checked. The tests
# run the shipping patterns against panes captured from live sessions, so a bad
# assumption fails here instead of showing up as a wrong dot or a stray chime.
if ! node "$DIR/test/detect.test.mjs" >/tmp/oneterm-detect.log 2>&1; then
  echo
  echo "✗ detection tests FAILED — NOT restarting."
  sed 's/^/  /' /tmp/oneterm-detect.log | tail -25
  exit 1
fi
echo "  detection tests pass ($(grep -c '✓' /tmp/oneterm-detect.log) checks)"

# The hook installer edits ~/.claude/settings.json, which Claude Code itself
# reads and other tools also write to. A bug here breaks the agent, not just
# oneterm, so it is gated like everything else. Runs against throwaway HOMEs.
if ! node "$DIR/test/install-hooks.test.mjs" >/tmp/oneterm-hooks.log 2>&1; then
  echo
  echo "✗ hook installer tests FAILED — NOT restarting."
  sed 's/^/  /' /tmp/oneterm-hooks.log | tail -25
  exit 1
fi
echo "  hook installer tests pass ($(grep -c '✓' /tmp/oneterm-hooks.log) checks)"

# The hook/pane decision has been wrong twice in opposite directions. It is a
# pure module precisely so it can be gated here rather than found by a human
# noticing a wrong dot.
if ! node "$DIR/test/agentstate.test.mjs" >/tmp/oneterm-agentstate.log 2>&1; then
  echo
  echo "✗ agent-state tests FAILED — NOT restarting."
  sed 's/^/  /' /tmp/oneterm-agentstate.log | tail -25
  exit 1
fi
echo "  agent-state tests pass ($(grep -c '✓' /tmp/oneterm-agentstate.log) checks)"

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

# A route can be dead while the host is perfectly healthy — /skills spent
# several commits returning {"error":"skillIndex is not defined"} because an
# edit deleted the function, and nothing here noticed. Smoke the endpoints.
FAILED=""
for ep in health sessions skills projects; do
  # 30s, not 5. This runs the instant the host is back, when /skills has to
  # BUILD its index (find -L across every skill dir) before it can answer.
  # Measured cold at 5.22s against 157 skills — just over the old 5s limit, so
  # the smoke test failed a perfectly healthy route, intermittently, forever.
  # A guard that cries wolf gets ignored, which defeats the point of having it.
  # A genuinely broken route still fails fast: it returns {"error":...}.
  BODY=$(curl -sf --max-time 30 "http://127.0.0.1:$PORT/$ep" 2>/dev/null)
  case "$BODY" in
    ''|*'"error"'*) FAILED="$FAILED /$ep" ;;
  esac
done
if [ -n "$FAILED" ]; then
  echo "✗ host is up but these routes are broken:$FAILED"
  echo "  check ~/Library/Logs/oneterm/host.log for [route error]"
  exit 1
fi

echo "✓ host up as pid $NEW_PID"
echo "✓ routes healthy: /health /sessions /skills /projects"
echo "✓ sessions: $SESSIONS_BEFORE before, $SESSIONS_AFTER after (tmux kept them)"
echo
echo "The browser reconnects on its own. Reload the tab only if you changed index.html."
