#!/bin/bash
# End-to-end proof that agent state comes from Claude Code's own events.
#
#   bash test/e2e-hook.sh
#
# Everything else in test/ is unit-level: it proves the state machine is
# self-consistent. This is the only thing that proves the CHAIN works — hook
# registered in ~/.claude/settings.json, fired by a real Claude Code, gated on
# the session env, delivered over HTTP, folded into state, and surfaced by
# /sessions. Any link breaking makes this fail and nothing else would.
#
# Costs one very small Claude turn. Creates and destroys its own session.
set -uo pipefail

PORT="${PORT:-7331}"
B="http://127.0.0.1:$PORT"
PASS=0; FAIL=0
ok(){   printf "  \033[32m✓\033[0m %s\n" "$1"; PASS=$((PASS+1)); }
bad(){  printf "  \033[31m✗\033[0m %s\n" "$1"; FAIL=$((FAIL+1)); }
post(){ curl -sf --max-time 10 -X POST -H "Origin: http://127.0.0.1:$PORT" "$B/$1"; }

# field of the session under test, e.g. `field working`
field(){ curl -sf --max-time 5 "$B/sessions" | python3 -c "
import json,sys
for s in json.load(sys.stdin):
    if s['id']=='$SID': print(s.get('$1')); break
else: print('GONE')"; }

# wait until a field equals a value, or time out. echoes how long it took.
await(){ # await <field> <value> <seconds>
  local t0 n=0
  t0=$(date +%s)
  while [ $n -lt $(( $3 * 2 )) ]; do
    [ "$(field "$1")" = "$2" ] && { echo $(( $(date +%s) - t0 )); return 0; }
    sleep 0.5; n=$((n+1))
  done
  echo -1; return 1
}

echo "oneterm hook end-to-end"
echo

curl -sf --max-time 3 "$B/health" >/dev/null || { bad "host is not running"; exit 1; }
grep -q oneterm-agent-state "$HOME/.claude/settings.json" 2>/dev/null \
  && ok "hook is registered in ~/.claude/settings.json" \
  || { bad "hook not registered — run: node bin/install-hooks.mjs"; exit 1; }

# ── create ──────────────────────────────────────────────────────────────────
SID=$(post "new?cmd=claude&cwd=$HOME/Projects/oneterm" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$SID" ] && ok "created session $SID" || { bad "could not create a session"; exit 1; }
trap 'post "kill?id=$SID" >/dev/null 2>&1' EXIT

echo "  waiting for Claude Code to start…"
sleep 14

# ── 1. SessionStart reached us ──────────────────────────────────────────────
if grep -q "\[hook\] $SID session" "$HOME/Library/Logs/oneterm/host.log"; then
  ok "SessionStart fired and reached the host"
else
  bad "no SessionStart event — the chain is broken at the hook or the gate"
fi

# An idle session must read idle. A false "working" here would mean the
# spinner-matching fallback is firing on a resting pane.
[ "$(field working)" = "False" ] && ok "a fresh idle session reads not-working" \
                                 || bad "idle session reports working=$(field working)"

# ── 2. a turn starts ────────────────────────────────────────────────────────
tmux send-keys -t "oneterm_$SID" -l 'Reply with exactly: OK'
sleep 0.4
tmux send-keys -t "oneterm_$SID" Enter

T=$(await working True 20)
if [ "$T" -ge 0 ]; then ok "turn detected as working after ${T}s"
else bad "turn never registered as working"; fi

[ "$(field stateFrom)" = "hook" ] \
  && ok "and the decision came from the HOOK, not pane matching" \
  || bad "decided by $(field stateFrom) — the hook did not drive this"

# The latch exists only to tolerate a missed sample of an animating pane. An
# event needs no such tolerance, and the client subtracts latchMs when it
# measures a run, so a stale value here shifts every chime.
[ "$(field latchMs)" = "0" ] \
  && ok "no latch applied while hook-driven" \
  || bad "latchMs=$(field latchMs) but the hook decided"

# ── 3. the turn ends ────────────────────────────────────────────────────────
T=$(await working False 60)
if [ "$T" -ge 0 ]; then ok "turn end detected after ${T}s"
else bad "turn end never registered"; fi

grep -q "\[hook\] $SID stop" "$HOME/Library/Logs/oneterm/host.log" \
  && ok "a Stop event was received" \
  || bad "no Stop event — end was inferred from the pane, not reported"

# ── 4. the pane and the rail agree ──────────────────────────────────────────
SPIN=$(tmux capture-pane -p -t "oneterm_$SID" | grep -cE '^\s*\S{1,2}\s+[A-Za-z][a-zA-Z-]*…' || true)
if [ "$SPIN" = "0" ] && [ "$(field working)" = "False" ]; then
  ok "pane shows no spinner and the rail agrees"
else
  bad "pane spinner=$SPIN but rail working=$(field working)"
fi

# ── 5. cleanup prunes persisted state ───────────────────────────────────────
post "kill?id=$SID" >/dev/null
trap - EXIT
sleep 3
curl -sf --max-time 5 "$B/sessions" >/dev/null       # a poll triggers the prune
sleep 1
if python3 -c "
import json,os,sys
p=os.path.expanduser('~/.oneterm/agent-state.json')
d=json.load(open(p)) if os.path.exists(p) else {}
sys.exit(0 if '$SID' not in d else 1)"; then
  ok "killed session pruned from agent-state.json"
else
  bad "state for a dead session survived on disk"
fi

echo
echo "─────────────────────────────"
echo "  $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ] && echo "  the whole chain works: Claude Code → hook → host → UI." \
                || echo "  the chain is broken."
exit $((FAIL > 0))
