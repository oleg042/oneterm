#!/bin/bash
# oneterm chaos test — proves the host survives the things that actually kill
# localhost servers. Creates its own throwaway session and cleans up after.
# Re-runnable any time:  bash bin/chaos.sh
set -uo pipefail

PORT="${PORT:-7331}"
LABEL="com.oneterm.host"
TMUX="$(command -v tmux || echo /opt/homebrew/bin/tmux)"
B="http://127.0.0.1:$PORT"
PASS=0; FAIL=0

ok(){   printf "  \033[32m✓\033[0m %s\n" "$1"; PASS=$((PASS+1)); }
bad(){  printf "  \033[31m✗\033[0m %s\n" "$1"; FAIL=$((FAIL+1)); }
health(){ curl -sf --max-time 2 "$B/health" >/dev/null 2>&1; }

# wait up to N seconds for the host to answer again
wait_up(){
  for i in $(seq 1 "${1:-20}"); do health && return 0; sleep 0.5; done
  return 1
}

echo "oneterm chaos test"
echo

# ── 0. baseline ─────────────────────────────────────────────────────────────
health && ok "host is up" || { bad "host is not up — run bin/install.sh"; exit 1; }

SID="chaos$$"
SESS="oneterm_$SID"
"$TMUX" new-session -d -s "$SESS" -c "$HOME" -x 100 -y 30 2>/dev/null
"$TMUX" set-option -t "$SESS" @oneterm_label "chaos test" >/dev/null 2>&1
"$TMUX" set-option -t "$SESS" @oneterm_cwd "$HOME"        >/dev/null 2>&1
"$TMUX" set-option -t "$SESS" @oneterm_cmd "shell"        >/dev/null 2>&1
sleep 0.6
# a marker only THIS shell process can know
"$TMUX" send-keys -t "$SESS" "CHAOS_MARKER=$SID" Enter
sleep 0.6
"$TMUX" has-session -t "$SESS" 2>/dev/null && ok "test session created" \
  || { bad "could not create test session"; exit 1; }

marker_alive(){
  "$TMUX" send-keys -t "$SESS" 'echo CHECK=$CHAOS_MARKER' Enter
  sleep 0.7
  "$TMUX" capture-pane -p -t "$SESS" 2>/dev/null | grep -q "CHECK=$SID"
}

# ── 1. SIGKILL: the ugliest death there is ─────────────────────────────────
echo
echo "1. SIGKILL the host (crash / force quit)"
PID_BEFORE=$(curl -s "$B/health" | sed -n 's/.*"pid":\([0-9]*\).*/\1/p')
kill -9 "$PID_BEFORE" 2>/dev/null
# Don't assert on a window of downtime: launchd often restarts the host in
# under 500ms, so "is it down right now?" is a race the supervisor wins. The
# honest signal is that the PID CHANGED — a new process is serving.
if wait_up 24; then
  PID_AFTER=$(curl -s "$B/health" | sed -n 's/.*"pid":\([0-9]*\).*/\1/p')
  if [ "$PID_BEFORE" != "$PID_AFTER" ]; then
    ok "killed pid $PID_BEFORE; launchd respawned as $PID_AFTER"
  else
    bad "pid unchanged ($PID_AFTER) — the kill did not land, test invalid"
  fi
else
  bad "host did NOT come back"
fi
marker_alive && ok "tmux session survived, same shell process" || bad "session lost"

# ── 2. repeated kills: does it give up? ────────────────────────────────────
echo
echo "2. kill it 3 more times in a row"
for n in 1 2 3; do
  P=$(curl -s "$B/health" | sed -n 's/.*"pid":\([0-9]*\).*/\1/p')
  [ -n "$P" ] && kill -9 "$P" 2>/dev/null
  sleep 3.5
done
wait_up 30 && ok "still coming back after 4 total kills" || bad "gave up after repeated kills"
marker_alive && ok "session still intact after 4 kills" || bad "session lost"

# ── 3. a bad request must not take the process down ────────────────────────
echo
echo "3. malformed / hostile requests"
PID_BEFORE=$(curl -s "$B/health" | sed -n 's/.*"pid":\([0-9]*\).*/\1/p')
curl -s --max-time 2 "$B/kill?id=%%%%"                    >/dev/null 2>&1
curl -s --max-time 2 "$B/new?cmd=claude&cwd=/nope/nowhere" >/dev/null 2>&1
curl -s --max-time 2 "$B/../../etc/passwd"                 >/dev/null 2>&1
curl -s --max-time 2 "$B/sessions?x=%E0%A4%A"              >/dev/null 2>&1
sleep 1
PID_AFTER=$(curl -s "$B/health" | sed -n 's/.*"pid":\([0-9]*\).*/\1/p')
if [ -n "$PID_AFTER" ] && [ "$PID_BEFORE" = "$PID_AFTER" ]; then
  ok "same process still serving — bad requests did not restart it"
elif [ -n "$PID_AFTER" ]; then
  bad "process restarted (pid $PID_BEFORE → $PID_AFTER): a request crashed it"
else
  bad "host is down after malformed requests"
fi

# ── 4. restart-on-login path ────────────────────────────────────────────────
echo
echo "4. full launchd reload (stands in for logout / reboot)"
launchctl kickstart -k "gui/$UID/$LABEL" >/dev/null 2>&1
wait_up 24 && ok "came back from a cold kickstart" || bad "did not come back"
marker_alive && ok "session survived the reload too" || bad "session lost"

# ── cleanup ────────────────────────────────────────────────────────────────
"$TMUX" kill-session -t "$SESS" 2>/dev/null
echo
echo "─────────────────────────────"
printf "  %d passed, %d failed\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && echo "  rock solid." || echo "  NOT solid — see failures above."
exit "$FAIL"
