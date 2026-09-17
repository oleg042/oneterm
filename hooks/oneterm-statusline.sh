#!/bin/sh
# oneterm status-line reporter — installed by bin/install-hooks.mjs.
#
# WHY THIS EXISTS
# Claude Code hands its status line command a JSON blob on stdin that already
# contains the numbers we want, computed by Claude Code itself:
#
#   context_window.used_percentage      the % — no inference needed
#   context_window.context_window_size  the cap, already correct for the
#                                       ACTIVE model, and it follows a
#                                       mid-session /model switch for free
#   model.display_name                  "Opus 5", "Fable 5.1", …
#
# This is the ONLY first-party channel carrying that. Deriving it from the
# transcript means guessing the cap, and the guess is wrong on every session
# using the 1M window — so we read it from the source or not at all.
#
# DESIGN RULES — the first two are the ones oneterm-agent-state.sh lives by,
# for the same reasons, and this file runs far more often than that one:
#  1. Drain stdin FIRST, before any gate. Registered globally, this runs for
#     every Claude Code on the machine. Exiting before reading leaves Claude
#     Code writing into a pipe with no reader — EPIPE in the agent, not here.
#  2. Never break the agent, and never block the render. Every path exits 0,
#     the POST is backgrounded and time-boxed.
#  3. WRAP, don't replace. A status line is a single global setting and the
#     user may already have had one. Whatever was configured before us still
#     runs, with the same stdin, and its output is what gets displayed.
#  4. LEAVE NOBODY WORSE OFF. Configuring any status line makes Claude Code
#     drop most of its footer keyboard hints — `esc to interrupt`, `? for
#     shortcuts`. A user who had no status line would trade those for a blank
#     row, which is a straight loss. So when there is nothing to wrap we print
#     a useful line of our own, and the row earns the space it took.
set -u
export PYTHONIOENCODING=utf-8

# --- drain stdin FIRST, before any gate ------------------------------------
INPUT="$(cat 2>/dev/null || true)"

CLAUDE_DIR="${CLAUDE_HOME:-$HOME/.claude}"
INNER="$(cat "$CLAUDE_DIR/oneterm-statusline.inner" 2>/dev/null || true)"

GATED=0
if [ "${ONETERM:-}" = "1" ] && [ -n "${ONETERM_SESSION:-}" ]; then GATED=1; fi

# Parse once, and only when the answer is actually used: when we have a report
# to send, or when we owe this session a status line of our own.
OUT=""
if [ "$GATED" = "1" ] || [ -z "$INNER" ]; then
  if command -v python3 >/dev/null 2>&1; then
    OUT="$(printf '%s' "$INPUT" | ONETERM_SESSION="${ONETERM_SESSION:-}" python3 -c '
import json, os, sys

def out(*lines):
    sys.stdout.write("\n".join(lines) + "\n")

try:
    d = json.load(sys.stdin)
except Exception:
    raise SystemExit(1)

c = d.get("context_window") or {}
m = d.get("model") or {}
model = m.get("display_name") or m.get("id") or ""
pct = c.get("used_percentage")
try:
    pct = None if pct is None else max(0, min(100, int(round(float(pct)))))
except Exception:
    pct = None

# Account-level rate limits. These are NOT per-session — every session on the
# same account reports the same numbers — but they arrive on this payload and
# nowhere else, so this is the only channel that has them. Only the windows
# Claude Code actually sends are forwarded: `spend_limit` exists in the schema
# but appears only behind a Claude apps gateway, and there is no model-scoped
# window at all, so a Fable-specific meter cannot be built from this.
rl = d.get("rate_limits") or {}
limits = {}
for key in ("five_hour", "seven_day", "spend_limit"):
    w = rl.get(key) or {}
    p = w.get("used_percentage")
    if p is None:
        continue
    try:
        limits[key] = {"pct": max(0, min(100, int(round(float(p))))),
                       "resets": int(w.get("resets_at") or 0)}
    except Exception:
        pass

# line 1: debounce key   line 2: request body   line 3: our own status line
sig = body = ""
if pct is not None:
    # The limits ride the same debounce: they move slowly, but when they do the
    # rail has to follow, so they belong in the key rather than waiting for the
    # context percent to happen to change.
    sig = "|".join([model, str(pct)]
                   + [k + str(v["pct"]) for k, v in sorted(limits.items())])
    body = json.dumps({
        "id":            os.environ.get("ONETERM_SESSION", ""),
        "action":        "status",
        "claudeSession": d.get("session_id") or "",
        "model":         model,
        "ctxPct":        pct,
        "ctxSize":       c.get("context_window_size") or 0,
        "limits":        limits,
    })

# The fallback line, used only when no status line existed before us. Built
# from the same payload: directory, branch, model, and the context bar.
cwd = d.get("cwd") or (d.get("workspace") or {}).get("current_dir") or ""
home = os.path.expanduser("~")
if cwd.startswith(home):
    cwd = "~" + cwd[len(home):]
branch = ((d.get("git") or {}).get("branch")
          or (d.get("workspace") or {}).get("git_worktree") or "")
parts = [cwd + (" (" + branch + ")" if branch else "")] if cwd else []
if model:
    parts.append(model)
if pct is not None:
    filled = pct * 10 // 100
    parts.append("█" * filled + "░" * (10 - filled) + " " + str(pct) + "%")
out(sig, body, " | ".join(parts))
' 2>/dev/null)" || OUT=""
  fi
fi

SIG=""; BODY=""; MINE=""
if [ -n "$OUT" ]; then
  SIG="$(printf '%s\n' "$OUT" | sed -n '1p')"
  BODY="$(printf '%s\n' "$OUT" | sed -n '2p')"
  MINE="$(printf '%s\n' "$OUT" | sed -n '3p')"
fi

# --- report, but only from inside a oneterm session -------------------------
if [ "$GATED" = "1" ] && [ -n "$BODY" ] && command -v curl >/dev/null 2>&1; then
  PORT="${ONETERM_PORT:-7331}"   # sessions created before the port was stamped
  # Debounce. The status line re-renders constantly — on keystrokes, on the
  # spinner, on focus — and the rail can only show whole percent. One POST per
  # render would be hundreds of pointless writes a minute, each one rewriting
  # agent-state.json on the host. Only speak when the number has changed.
  STATE="${TMPDIR:-/tmp}/oneterm-sl-${ONETERM_SESSION}"
  LAST="$(cat "$STATE" 2>/dev/null || true)"
  if [ -n "$SIG" ] && [ "$SIG" != "$LAST" ]; then
    # Record what we reported only AFTER the host accepts it, and do both
    # inside the background subshell so the render still never waits.
    #
    # Writing the marker first looks equivalent and is not: the host is
    # restartable, and `bin/reload.sh` is the normal way to ship a change.
    # Every session's status line re-renders during that window, so every POST
    # fails against a host that is down — and a marker written anyway would
    # suppress the retry until the percentage happened to move, which for an
    # idle session is never. Observed exactly that: seven sessions reported at
    # the same second as a restart and the rail stayed empty.
    { curl -sf -o /dev/null --max-time 2 \
        -X POST \
        -H 'Content-Type: application/json' \
        -H "Origin: http://127.0.0.1:${PORT}" \
        --data "$BODY" \
        "http://127.0.0.1:${PORT}/agent-event" \
      && printf '%s' "$SIG" > "$STATE"; } >/dev/null 2>&1 &
  fi
fi

# --- render ----------------------------------------------------------------
# Unconditional, and for every session on the machine: taking over the setting
# must not cost anyone the status line they already had, and must not leave a
# blank row for anyone who had none.
if [ -n "$INNER" ]; then
  printf '%s' "$INPUT" | sh -c "$INNER" 2>/dev/null || true
elif [ -n "$MINE" ]; then
  printf '%s\n' "$MINE"
fi

exit 0
