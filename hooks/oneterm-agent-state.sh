#!/bin/sh
# oneterm agent-state hook — installed by bin/install.sh into ~/.claude/hooks/.
#
# WHY THIS EXISTS
# Claude Code publishes lifecycle events. oneterm used to infer the same
# information by running regexes over `tmux capture-pane` output — reading a
# UI that nobody promised would stay the same. That broke six times in one
# week: the animated spinner, a finished step's elapsed timer, the /goal badge,
# an MCP banner that never scrolls away, Claude's own prose "do you want me
# to…", and an assumption that the status line sits at the bottom of the pane.
# Every one was silent: a wrong dot, or a chime on a run that had not stopped.
#
# This reports the events instead. Turn boundaries become facts.
#
# DESIGN RULES, both learned from herdr's integration:
#  1. Gate on our own env var. This file is registered GLOBALLY in
#     ~/.claude/settings.json, so it runs for every Claude Code session on the
#     machine — including ones oneterm knows nothing about, and ones belonging
#     to other tools. ONETERM_SESSION is stamped only on sessions we create, so
#     everywhere else this exits before doing anything at all.
#  2. Never break the agent. Every path exits 0. A hook that fails must cost
#     the user nothing, so there is no `set -e`, every call is guarded, and the
#     network timeout is short and absolute.
set -u

# --- drain stdin FIRST, before any gate -----------------------------------
# This must precede the gate, and the ordering is the whole point. The hook is
# registered globally, so it runs for every Claude Code on the machine and the
# gate below rejects nearly all of them. Exiting before reading leaves Claude
# Code writing a payload into a pipe with no reader: UserPromptSubmit carries
# the submitted prompt, and a pasted stack trace or file blows past a pipe
# buffer, so the write blocks and then fails EPIPE — in the agent, not here.
# herdr drains unconditionally on its first line for exactly this reason.
INPUT="$(cat 2>/dev/null || true)"

# --- gate: are we inside a oneterm session? -------------------------------
[ "${ONETERM:-}" = "1" ] || exit 0
[ -n "${ONETERM_SESSION:-}" ] || exit 0

ACTION="${1:-}"
PORT="${ONETERM_PORT:-7331}"

# --- which events mean what ------------------------------------------------
# start  : a turn began            -> working
# stop   : the turn ended          -> not working  (this is the "done" edge)
# session: a session was created   -> link our id to Claude's session id
#
# SubagentStop is deliberately NOT mapped. It is a completion event that Claude
# can emit AFTER the main turn has already finished (recap / away-summary), so
# treating it as a state change lets a finished session flap back to working —
# which is exactly the false "done" chime that made this rewrite necessary.
case "$ACTION" in
  start|stop|session) ;;
  *) exit 0 ;;
esac

# Extract the two fields worth having. python3 is present on every macOS since
# 12 and on any machine that can run Claude Code; if it is somehow missing we
# still report the event, just without the ids.
# Let python build the JSON body: a transcript path is arbitrary text, and
# hand-rolling it with printf would break on a quote or a backslash and send a
# malformed body the host would silently drop.
BODY=""
if command -v python3 >/dev/null 2>&1; then
  BODY="$(printf '%s' "$INPUT" | ONETERM_ACTION="$ACTION" python3 -c '
import json, os, sys
try:
    d = json.load(sys.stdin)
except Exception:
    d = {}
# A SUBAGENT finishing is not the main agent changing state. Herdr learned this
# the hard way and says so in its own hook; an agent_id means this event
# belongs to a child, and letting it through revives an idle session.
if d.get("agent_id"):
    raise SystemExit(1)
print(json.dumps({
    "id":            os.environ["ONETERM_SESSION"],
    "action":        os.environ["ONETERM_ACTION"],
    "claudeSession": d.get("session_id") or "",
    "transcript":    d.get("transcript_path") or "",
    "event":         d.get("hook_event_name") or "",
}))
' 2>/dev/null)" || exit 0
fi
# No python, or it produced nothing: still report the state change, since the
# id and action are the parts that actually drive the UI. Both are known-safe
# characters, so printf is sound for this narrow case.
[ -n "$BODY" ] || BODY="$(printf '{"id":"%s","action":"%s"}' "$ONETERM_SESSION" "$ACTION")"

# --- report ----------------------------------------------------------------
# POST, because it changes state and the host rejects state-changing GETs.
# --max-time is the whole point: the host may be mid-restart, and a hook that
# hangs would hang the agent along with it.
command -v curl >/dev/null 2>&1 || exit 0
curl -sf -o /dev/null --max-time 2 \
  -X POST \
  -H 'Content-Type: application/json' \
  -H "Origin: http://127.0.0.1:${PORT}" \
  --data "$BODY" \
  "http://127.0.0.1:${PORT}/agent-event" 2>/dev/null || true

exit 0
