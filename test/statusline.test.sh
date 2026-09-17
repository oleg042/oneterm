#!/bin/bash
# The status-line wrapper. It runs on EVERY render of EVERY Claude Code session
# on the machine, and it takes over a setting the user may already have been
# using — so its failure modes matter more than its features.
#   bash test/statusline.test.sh
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SL="$DIR/hooks/oneterm-statusline.sh"
PASS=0; FAIL=0
ok(){  printf "  \033[32m✓\033[0m %s\n" "$1"; PASS=$((PASS+1)); }
bad(){ printf "  \033[31m✗\033[0m %s\n" "$1"; FAIL=$((FAIL+1)); }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export CLAUDE_HOME="$TMP"
export TMPDIR="$TMP"
INNER_FILE="$CLAUDE_HOME/oneterm-statusline.inner"

PAY='{"session_id":"abc-123","cwd":"/tmp","model":{"id":"claude-fable-5-1",
 "display_name":"Fable 5.1"},"context_window":{"used_percentage":81,
 "context_window_size":1000000},"exceeds_200k_tokens":false}'

echo "oneterm status line"
echo

sh -n "$SL" && ok "valid POSIX sh" || bad "syntax error"

# ── the one that can break every session on the machine ────────────────────
# Claude Code writes the status JSON to our stdin on every render. Exiting
# before reading it gives Claude Code EPIPE — and unlike the agent-state hook,
# this fires continuously rather than once a turn.
python3 -c "import sys; sys.stdout.write('x'*200000)" 2>/dev/null | sh "$SL" >/dev/null 2>&1
W=${PIPESTATUS[0]}
[ "$W" = "0" ] && ok "drains 200KB before gating (writer exit 0, no EPIPE)" \
               || bad "writer got exit $W — Claude Code would take a broken pipe"

# ── the gate ───────────────────────────────────────────────────────────────
# Ungated means "do not REPORT", not "do not render": the setting is global, so
# every Claude Code on the machine still has to get a status line out of us.
rm -f "$TMPDIR"/oneterm-sl-* 2>/dev/null
OUT=$(printf '%s' "$PAY" | sh "$SL" 2>&1); RC=$?
[ $RC = 0 ] && ok "exits 0 outside a oneterm session" || bad "exit $RC when ungated"
[ -z "$(ls "$TMPDIR"/oneterm-sl-* 2>/dev/null)" ] \
  && ok "reports nothing from a session that is not ours" \
  || bad "a foreign session was reported to the host"

# ── never block the render ─────────────────────────────────────────────────
START=$(python3 -c 'import time; print(time.time())')
printf '%s' "$PAY" | ONETERM=1 ONETERM_SESSION=s1 ONETERM_PORT=9 sh "$SL" >/dev/null 2>&1
RC=$?
EL=$(python3 -c "import time; print(f'{time.time()-$START:.2f}')")
[ $RC = 0 ] && ok "exits 0 with the host unreachable" || bad "exit $RC with host down"
awk "BEGIN{exit !($EL < 1.5)}" && ok "and returns in ${EL}s — the POST never blocks the render" \
                               || bad "took ${EL}s, which stalls every frame"

# ── malformed input must not matter ────────────────────────────────────────
for desc in non-JSON empty no-context-window; do
  case $desc in
    non-JSON)           IN='not json' ;;
    empty)              IN='' ;;
    no-context-window)  IN='{"session_id":"x"}' ;;
  esac
  printf '%s' "$IN" | ONETERM=1 ONETERM_SESSION=s1 ONETERM_PORT=9 sh "$SL" >/dev/null 2>&1
  [ $? = 0 ] && ok "survives $desc on stdin" || bad "failed on $desc"
done

# ── WRAP, don't replace ────────────────────────────────────────────────────
# Taking over statusLine must not cost the user the status line they had.
# Heredocs, not printf: printf eats backslash escapes and would hand python a
# script full of bare identifiers instead of string keys.
cat > "$TMP/inner.sh" <<'EOF'
#!/bin/sh
cat >/dev/null; printf 'INNER-RAN'
EOF
chmod +x "$TMP/inner.sh"
printf '%s' "sh $TMP/inner.sh" > "$INNER_FILE"

OUT=$(printf '%s' "$PAY" | sh "$SL" 2>/dev/null)
[ "$OUT" = "INNER-RAN" ] && ok "runs the previous status line when ungated" \
                         || bad "pass-through lost outside a oneterm session (got '$OUT')"

OUT=$(printf '%s' "$PAY" | ONETERM=1 ONETERM_SESSION=s2 ONETERM_PORT=9 sh "$SL" 2>/dev/null)
[ "$OUT" = "INNER-RAN" ] && ok "runs the previous status line inside one too" \
                         || bad "pass-through lost inside a oneterm session (got '$OUT')"

# the inner command must receive the SAME payload, not an empty pipe
cat > "$TMP/echo.sh" <<'EOF'
#!/bin/sh
python3 -c 'import json,sys; print(json.load(sys.stdin)["model"]["display_name"])'
EOF
chmod +x "$TMP/echo.sh"
printf '%s' "sh $TMP/echo.sh" > "$INNER_FILE"
OUT=$(printf '%s' "$PAY" | sh "$SL" 2>/dev/null)
[ "$OUT" = "Fable 5.1" ] && ok "hands the inner command the original stdin" \
                         || bad "inner command got '$OUT', not the payload"

# a broken inner command must not take us down with it
printf '%s' "sh -c 'exit 7'" > "$INNER_FILE"
printf '%s' "$PAY" | sh "$SL" >/dev/null 2>&1
[ $? = 0 ] && ok "survives a failing inner status line" || bad "a broken inner command propagated"

# ── leave nobody worse off ─────────────────────────────────────────────────
# No previous status line is the common case on a fresh machine. Configuring
# ANY status line makes Claude Code drop most of its footer keyboard hints
# (`esc to interrupt`, `? for shortcuts`), so a blank row would be a straight
# loss for someone who had none. The row we took has to earn itself.
rm -f "$INNER_FILE"
OUT=$(printf '%s' "$PAY" | sh "$SL" 2>/dev/null)
case "$OUT" in
  *"Fable 5.1"*) ok "prints a line of its own when there was nothing to wrap" ;;
  *) bad "expected a fallback status line, got '$OUT'" ;;
esac
case "$OUT" in
  *█*░*"81%"*) ok "…carrying the context bar and percent" ;;
  *) bad "no context bar in '$OUT'" ;;
esac
case "$OUT" in
  */tmp*) ok "…and the working directory" ;;
  *) bad "no cwd in '$OUT'" ;;
esac

# but when there IS something to wrap, only theirs renders — never both
printf '%s' "sh $TMP/inner.sh" > "$INNER_FILE"
OUT=$(printf '%s' "$PAY" | sh "$SL" 2>/dev/null)
[ "$OUT" = "INNER-RAN" ] && ok "never doubles up: our line is suppressed when theirs exists" \
                         || bad "printed '$OUT' — both lines rendered"
rm -f "$INNER_FILE"

# ── debounce, against a host that is actually listening ────────────────────
# The status line re-renders constantly. Reporting every frame would rewrite
# agent-state.json hundreds of times a minute for a number that did not move.
LOG="$TMP/posts.log"
cat > "$TMP/host.py" <<'EOF'
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get('content-length') or 0)
        with open(sys.argv[2], 'a') as f:
            f.write(self.rfile.read(n).decode('utf8', 'replace') + '\n')
        self.send_response(200); self.end_headers(); self.wfile.write(b'{"ok":true}')
    def log_message(self, *a): pass
HTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
EOF
PORT=8931
python3 "$TMP/host.py" "$PORT" "$LOG" & HOST_PID=$!
disown 2>/dev/null || true
trap 'kill $HOST_PID 2>/dev/null; rm -rf "$TMP"' EXIT
for _ in $(seq 1 40); do
  curl -sf -m 1 -X POST --data '{}' "http://127.0.0.1:$PORT/agent-event" >/dev/null 2>&1 && break
  sleep 0.1
done
: > "$LOG"
sl(){ printf '%s' "$1" | ONETERM=1 ONETERM_SESSION=d1 ONETERM_PORT=$PORT sh "$SL" >/dev/null 2>&1
      sleep 0.5; }   # the POST is backgrounded on purpose; let it land
posts(){ grep -c . "$LOG" 2>/dev/null || echo 0; }

rm -f "$TMPDIR"/oneterm-sl-*
sl "$PAY"
[ "$(posts)" = "1" ] && ok "reports once when the host is up" || bad "$(posts) posts, expected 1"
BODY=$(tail -1 "$LOG")
echo "$BODY" | grep -q '"ctxPct": *81' && echo "$BODY" | grep -q '"action": *"status"' \
  && echo "$BODY" | grep -q '"model": *"Fable 5.1"' \
  && ok "posts Claude Code's own numbers, not a derived guess" || bad "unexpected body: $BODY"
FIRST=$(cat "$TMPDIR/oneterm-sl-d1" 2>/dev/null)
[ "$FIRST" = "Fable 5.1|81" ] && ok "debounce key is model+percent ('$FIRST')" \
                              || bad "unexpected debounce key '$FIRST'"

sl "$PAY"
[ "$(posts)" = "1" ] && ok "an unchanged percent stays quiet" || bad "re-posted an identical reading"

sl "${PAY/81/82}"
[ "$(posts)" = "2" ] && ok "a changed percent reports again" || bad "a changed percent did not report"

# a model switch mid-session must report even at an unchanged percent
sl "${PAY//Fable 5.1/Opus}"
[ "$(posts)" = "3" ] && ok "a model switch reports at the same percent" \
                     || bad "model change was debounced away"
[ "$(cat "$TMPDIR/oneterm-sl-d1")" = "Opus|81" ] && ok "and the key follows the model" \
                                                 || bad "key did not follow the model switch"

# ── THE REGRESSION: a failed report must not count as reported ──────────────
# The host is restartable and bin/reload.sh is the normal way to ship a change.
# Every session re-renders during that window, so every POST fails. Marking the
# reading as sent anyway suppresses the retry until the number moves — which for
# an idle session is never. Seven sessions went blank exactly this way.
kill $HOST_PID 2>/dev/null; wait $HOST_PID 2>/dev/null
BEFORE=$(cat "$TMPDIR/oneterm-sl-d1" 2>/dev/null)
printf '%s' "${PAY/81/99}" | ONETERM=1 ONETERM_SESSION=d1 ONETERM_PORT=$PORT sh "$SL" >/dev/null 2>&1
sleep 0.5
[ "$(cat "$TMPDIR/oneterm-sl-d1" 2>/dev/null)" = "$BEFORE" ] \
  && ok "a POST that never landed is NOT recorded as reported" \
  || bad "a failed report was recorded — the retry is now suppressed"

# and once the host is back, the pending reading goes out without waiting
# for the percentage to move again
python3 "$TMP/host.py" "$PORT" "$LOG" & HOST_PID=$!
disown 2>/dev/null || true
for _ in $(seq 1 40); do
  curl -sf -m 1 -X POST --data '{}' "http://127.0.0.1:$PORT/agent-event" >/dev/null 2>&1 && break
  sleep 0.1
done
: > "$LOG"
sl "${PAY/81/99}"
[ "$(posts)" = "1" ] && ok "the same reading is retried once the host returns" \
                     || bad "the reading was lost across a host restart"

# ── the body it would POST ─────────────────────────────────────────────────
BODY=$(printf '%s' "$PAY" | python3 -c '
import json,sys
d=json.load(sys.stdin); c=d["context_window"]; m=d["model"]
pct=max(0,min(100,int(round(float(c["used_percentage"])))))
print(json.dumps({"action":"status","model":m["display_name"],"ctxPct":pct,
                  "ctxSize":c["context_window_size"]},sort_keys=True))')
EXP='{"action": "status", "ctxPct": 81, "ctxSize": 1000000, "model": "Fable 5.1"}'
[ "$BODY" = "$EXP" ] && ok "reports Claude Code's own numbers, not a derived guess" \
                     || bad "body was $BODY"

# used_percentage is somebody else's number and the rail renders it as a width
CLAMP=$(printf '%s' "${PAY/81/135}" | python3 -c '
import json,sys
c=json.load(sys.stdin)["context_window"]
print(max(0,min(100,int(round(float(c["used_percentage"]))))))')
[ "$CLAMP" = "100" ] && ok "an out-of-range percent clamps to 100" || bad "clamp gave '$CLAMP'"

echo
echo "─────────────────────────────"
echo "  $PASS passed, $FAIL failed"
exit $((FAIL > 0))
