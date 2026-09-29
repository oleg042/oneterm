#!/bin/bash
# End-to-end: the awake switch's routes against a RUNNING host.
#
#   PORT=7333 bash test/e2e-sleep.sh      (a host started from a worktree)
#   bash test/e2e-sleep.sh                (the installed host on 7331)
#
# It never changes your sleep setting. The one write it makes asks pmset for
# the value the Mac ALREADY has — which exercises the real sudo path, or
# without the sudoers rule the real refusal — and it checks afterwards that
# the setting is exactly what it was.
set -uo pipefail

PORT="${PORT:-7331}"
B="http://127.0.0.1:$PORT"
O="Origin: http://127.0.0.1:$PORT"
PASS=0; FAIL=0
ok(){  printf "  \033[32m✓\033[0m %s\n" "$1"; PASS=$((PASS+1)); }
bad(){ printf "  \033[31m✗\033[0m %s\n" "$1"; FAIL=$((FAIL+1)); }
truth(){ /usr/bin/pmset -g | sed -n 's/^[[:space:]]*SleepDisabled[[:space:]]*\([0-9]*\).*/\1/p'; }
field(){ python3 -c "
import json,sys
try: v=json.load(sys.stdin).get('$1')
except Exception: v='unparseable'
print('null' if v is None else str(v).lower())"; }

echo "oneterm awake switch end-to-end ($B)"
echo

curl -sf --max-time 3 "$B/health" >/dev/null || { bad "host is not running on $PORT"; exit 1; }

T=$(truth)
WANT=$([ "$T" = 0 ] && echo false || echo true)
[ "$(curl -s "$B/sleep" | field disabled)" = "$WANT" ] \
  && ok "GET /sleep reports what pmset reports (SleepDisabled $T)" \
  || bad "GET /sleep: $(curl -s "$B/sleep" | head -c 200)"

# ── guarded like every other mutation ──────────────────────────────────────
[ "$(curl -s -o /dev/null -w '%{http_code}' "$B/sleep/set?on=1")" = 405 ] \
  && ok "GET /sleep/set is refused (405) — an <img> cannot keep your Mac awake" \
  || bad "GET /sleep/set was not refused"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Origin: http://evil.example' "$B/sleep/set?on=1")" = 403 ] \
  && ok "a foreign Origin is refused (403)" || bad "a foreign Origin was not refused"
R=$(curl -s -w ' %{http_code}' -X POST -H "$O" "$B/sleep/set?on=maybe")
case "$R" in *bad_value*400) ok "anything but 0 or 1 is 400 bad_value" ;;
  *) bad "on=maybe: $R" ;; esac

# ── the one write: the value it already has ────────────────────────────────
R=$(curl -s -w ' %{http_code}' --max-time 20 -X POST -H "$O" "$B/sleep/set?on=$T")
if sudo -n -l /usr/bin/pmset -a disablesleep "$T" >/dev/null 2>&1; then
  case "$R" in *"\"disabled\":$WANT"*200) ok "with the rule installed, a set goes through sudo and reports the real state" ;;
    *) bad "set with the rule installed: $R" ;; esac
else
  case "$R" in *needs_setup*409) ok "without the rule, a set is 409 needs_setup — never a hang on a password prompt" ;;
    *) bad "set without the rule: $R" ;; esac
  case "$R" in *install-sleep-switch.sh*) ok "…and it names the script that fixes it" ;;
    *) bad "the refusal does not name the fix: $R" ;; esac
fi
[ "$(truth)" = "$T" ] && ok "your sleep setting is unchanged (SleepDisabled $T)" \
  || bad "SLEEP SETTING CHANGED: was $T, now $(truth)"

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
