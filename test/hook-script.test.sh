#!/bin/bash
# The hook script itself. It runs inside Claude Code's critical path, on EVERY
# session on the machine, so its failure modes matter more than its features.
#   bash test/hook-script.test.sh
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK="$DIR/hooks/oneterm-agent-state.sh"
PASS=0; FAIL=0
ok(){  printf "  \033[32m✓\033[0m %s\n" "$1"; PASS=$((PASS+1)); }
bad(){ printf "  \033[31m✗\033[0m %s\n" "$1"; FAIL=$((FAIL+1)); }
big(){ python3 -c "import sys; sys.stdout.write('x'*200000); sys.stdout.flush()"; }

echo "oneterm hook script"
echo

sh -n "$HOOK" && ok "valid POSIX sh" || bad "syntax error"

# ── the one that can break the AGENT rather than us ─────────────────────────
# Claude Code writes the payload to our stdin. UserPromptSubmit carries the
# submitted prompt, so a pasted stack trace easily exceeds a pipe buffer. If we
# exit before reading, that write fails EPIPE — in Claude Code. The gate must
# therefore come AFTER the drain, and this is the regression test for it.
big 2>/dev/null | sh "$HOOK" start
W=${PIPESTATUS[0]}
[ "$W" = "0" ] && ok "drains 200KB before gating (writer exit 0, no EPIPE)" \
               || bad "writer got exit $W — Claude Code would take a broken pipe"

# ── the gate ────────────────────────────────────────────────────────────────
OUT=$(echo '{}' | sh "$HOOK" start 2>&1); RC=$?
[ $RC = 0 ] && [ -z "$OUT" ] && ok "silent no-op outside a oneterm session" \
                             || bad "produced output or exit $RC when ungated"

START=$(python3 -c 'import time; print(time.time())')
echo '{}' | sh "$HOOK" start
EL=$(python3 -c "import time; print(f'{time.time()-$START:.2f}')")
awk "BEGIN{exit !($EL < 0.5)}" && ok "returns in ${EL}s when ungated" \
                               || bad "took ${EL}s — too slow for the agent's path"

# ── the host is unreachable (restarting, or never installed) ───────────────
START=$(python3 -c 'import time; print(time.time())')
echo '{"session_id":"s"}' | ONETERM=1 ONETERM_SESSION=probe ONETERM_PORT=9 sh "$HOOK" start
RC=$?
EL=$(python3 -c "import time; print(f'{time.time()-$START:.2f}')")
[ $RC = 0 ] && ok "exits 0 with the host unreachable" || bad "exit $RC with host down"
awk "BEGIN{exit !($EL < 3)}" && ok "and gives up in ${EL}s (bounded by --max-time)" \
                             || bad "hung for ${EL}s — would stall the agent"

# ── malformed input must not matter ────────────────────────────────────────
echo 'not json' | ONETERM=1 ONETERM_SESSION=probe ONETERM_PORT=9 sh "$HOOK" start
[ $? = 0 ] && ok "survives non-JSON on stdin" || bad "failed on malformed input"

printf '' | ONETERM=1 ONETERM_SESSION=probe ONETERM_PORT=9 sh "$HOOK" start
[ $? = 0 ] && ok "survives empty stdin" || bad "failed on empty input"

ONETERM=1 ONETERM_SESSION=probe ONETERM_PORT=9 sh "$HOOK" bogus-action </dev/null
[ $? = 0 ] && ok "ignores an unknown action" || bad "failed on unknown action"

# ── subagents must never reach the host ────────────────────────────────────
# A SubagentStop can fire AFTER the main turn ended. Letting it through revives
# a finished session — the false "done" chime this whole rewrite exists to kill.
OUT=$(echo '{"session_id":"s1","agent_id":"sub-1"}' \
      | ONETERM=1 ONETERM_SESSION=probe ONETERM_PORT=9 sh -x "$HOOK" stop 2>&1)
if echo "$OUT" | grep -q 'curl'; then
  bad "a subagent payload reached the reporting step"
else
  ok "a payload carrying agent_id is dropped before reporting"
fi

echo
echo "─────────────────────────────"
echo "  $PASS passed, $FAIL failed"
exit $((FAIL > 0))
