#!/bin/bash
# What the session runs AFTER claude exits.
#
# `claude` is a full-screen TUI: it turns on mouse tracking, focus reporting,
# bracketed paste and colour-scheme reports, and it turns them off again on a
# clean exit. On an unclean one — SIGKILL from Activity Monitor, an OOM, a
# crash — it does not. The session then falls through to a login shell that
# knows nothing about any of it, so every mouse MOVEMENT over the pane arrives
# at zsh as keystrokes and types itself onto the command line.
#   bash test/fallback-shell.test.sh
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0; FAIL=0
ok(){  printf "  \033[32m✓\033[0m %s\n" "$1"; PASS=$((PASS+1)); }
bad(){ printf "  \033[31m✗\033[0m %s\n" "$1"; FAIL=$((FAIL+1)); }

TMUX_BIN="$(command -v tmux)"
SOCK="oneterm-test-$$"
tm(){ "$TMUX_BIN" -L "$SOCK" "$@"; }
trap 'tm kill-server 2>/dev/null' EXIT

# A TUI that enables everything claude enables, then dies by SIGKILL without
# restoring any of it. This is the unclean exit, reproduced exactly.
DIRTY_TUI='sh -c "printf \"\033[?1003h\033[?1006h\033[?1004h\033[?2004h\033[?2031h\033[?25l\"; kill -9 \$\$"'

echo "oneterm fallback shell"
echo

# ── the constant actually has to exist and be used ─────────────────────────
RESET="$(sed -n 's/^const TTY_RESET = "\(.*\)"$/\1/p' "$DIR/server.mjs")"
[ -n "$RESET" ] && ok "server.mjs defines TTY_RESET" \
                || bad "server.mjs defines TTY_RESET"
grep -q '${TTY_RESET}' "$DIR/server.mjs" \
  && ok "the claude branch interpolates it" \
  || bad "the claude branch interpolates it"

# ── baseline: prove the dirty TUI really does leave the modes on ───────────
tm new-session -d -s dirty "$DIRTY_TUI; exec sh"
sleep 0.6
[ "$(tm display-message -t dirty -p '#{mouse_any_flag}')" = 1 ] \
  && ok "without the reset, mouse tracking survives into the shell" \
  || bad "without the reset, mouse tracking survives into the shell (test is not reproducing the bug)"

# ── the fix: same session, with the reset in between ───────────────────────
tm new-session -d -s clean "$DIRTY_TUI; $(printf '%b' "$RESET" 2>/dev/null || echo "$RESET"); exec sh"
sleep 0.6
for f in mouse_any_flag mouse_standard_flag mouse_button_flag mouse_sgr_flag mouse_utf8_flag; do
  v="$(tm display-message -t clean -p "#{$f}" 2>/dev/null)"
  [ "${v:-0}" = 0 ] && ok "$f cleared" || bad "$f is $v, expected 0"
done
v="$(tm display-message -t clean -p '#{cursor_flag}')"
[ "$v" = 1 ] && ok "cursor visible again" || bad "cursor_flag is $v, expected 1"

# ── and the session must still BE there afterwards ─────────────────────────
tm has-session -t clean 2>/dev/null \
  && ok "the session survives the reset" \
  || bad "the session survives the reset"

echo
printf "%d passed, %d failed\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
