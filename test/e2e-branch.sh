#!/bin/bash
# End-to-end: POST /branch against a RUNNING host.
#
#   PORT=7332 bash test/e2e-branch.sh      (a host started from a worktree)
#   bash test/e2e-branch.sh                (the installed host on 7331)
#
# Like e2e-hook.sh it creates real sessions on the real tmux server — they
# flash through the rail for a few seconds — and kills every one on exit.
#
# It never runs a Claude turn. The Claude-parent case is a SHELL session
# re-tagged as claude, pointed (through the same /agent-event route the hook
# uses) at a transcript written to a temp dir. The fork that launches cannot
# find that conversation and falls through to a shell, which is fine: what is
# under test is the host's decision and the command line it builds, not
# Claude Code.
set -uo pipefail

PORT="${PORT:-7331}"
B="http://127.0.0.1:$PORT"
O="Origin: http://127.0.0.1:$PORT"
PASS=0; FAIL=0
ok(){  printf "  \033[32m✓\033[0m %s\n" "$1"; PASS=$((PASS+1)); }
bad(){ printf "  \033[31m✗\033[0m %s\n" "$1"; FAIL=$((FAIL+1)); }
TMUX_BIN="$(command -v tmux)"
# pwd -P: mktemp hands out /var/…, and tmux reports the pane's REAL path,
# /private/var/…. Compare like with like.
TMP="$(cd "$(mktemp -d)" && pwd -P)"
MADE=()
cleanup(){
  for id in "${MADE[@]}"; do curl -s -X POST -H "$O" "$B/kill?id=$id" >/dev/null; done
  rm -rf "$TMP"
}
trap cleanup EXIT

post(){ curl -s --max-time 15 -X POST -H "$O" "$B/$1"; }
idof(){ sed -n 's/.*"id":"\([^"]*\)".*/\1/p'; }
# one session from /sessions as JSON, plus its index in the rail order
sess(){ curl -s "$B/sessions" | python3 -c "
import json,sys
L=json.load(sys.stdin); ids=[s['id'] for s in L]
s=next((x for x in L if x['id']=='$1'), None)
print(json.dumps(dict(s or {}, pos=ids.index('$1') if s else -1)))"; }
get(){ python3 -c "import json,sys; v=json.load(sys.stdin).get('$1'); print('' if v is None else v)"; }
opt(){ "$TMUX_BIN" show-options -v -t "oneterm_$1" "$2" 2>/dev/null; }
# Move a session's shell to a folder and wait until tmux reports it there.
# Needed because a login shell can cd away from where tmux started it — a
# `cd ~/Projects` at the top of .zshrc does exactly that, on the machine this
# was written on — so where a shell session "is" has to be set, not assumed.
goto(){
  "$TMUX_BIN" send-keys -t "oneterm_$1" "cd '$2'" Enter
  for _ in $(seq 1 40); do
    [ "$("$TMUX_BIN" display-message -p -t "oneterm_$1" '#{pane_current_path}')" = "$2" ] && return 0
    sleep 0.25
  done
  return 1
}

echo "oneterm branching end-to-end ($B)"
echo

curl -sf --max-time 3 "$B/health" >/dev/null || { bad "host is not running on $PORT"; exit 1; }

# ── the route is guarded like every other mutation ─────────────────────────
[ "$(curl -s -o /dev/null -w '%{http_code}' "$B/branch?id=x")" = 405 ] \
  && ok "GET /branch is refused (405) — an <img> cannot branch a session" \
  || bad "GET /branch was not refused"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Origin: http://evil.example' "$B/branch?id=x")" = 403 ] \
  && ok "a foreign Origin is refused (403)" || bad "a foreign Origin was not refused"
R=$(curl -s -w ' %{http_code}' -X POST -H "$O" "$B/branch?id=nope")
case "$R" in *no_such_session*404) ok "an unknown parent is 404 no_such_session" ;;
  *) bad "unknown parent: $R" ;; esac

# ── shell parent ───────────────────────────────────────────────────────────
mkdir -p "$TMP/work" "$TMP/moved"
P=$(post "new?cmd=shell&cwd=$TMP/work" | idof); MADE+=("$P")
[ -n "$P" ] && ok "created a shell parent $P" || { bad "could not create a parent"; exit 1; }
# Somewhere OTHER than where it was born: the branch must follow the live path.
goto "$P" "$TMP/moved" || bad "could not move the parent's shell"

C1=$(post "branch?id=$P" | idof); [ -n "$C1" ] && MADE+=("$C1")
[ -n "$C1" ] && ok "branched it → $C1" || bad "branching a shell returned no id"
PP=$(sess "$P" | get pos); CP=$(sess "$C1" | get pos)
[ "$CP" = $((PP + 1)) ] && ok "the branch sits directly under its parent" \
  || bad "branch at $CP, parent at $PP"
[ "$(sess "$C1" | get label)" = "↳ work" ] && ok "labelled ↳ work" \
  || bad "label: $(sess "$C1" | get label)"
[ "$(sess "$C1" | get cmd)" = "shell" ] && ok "a shell branches into a shell" \
  || bad "cmd: $(sess "$C1" | get cmd)"
# @oneterm_cwd is the folder the host asked tmux for. The branch's OWN live
# path is not checked: its login shell may cd away again, as the parent's did.
[ "$(opt "$C1" @oneterm_cwd)" = "$TMP/moved" ] && ok "in the parent's live folder, not the one it was born in" \
  || bad "branch asked for: $(opt "$C1" @oneterm_cwd)"

C2=$(post "branch?id=$P" | idof); [ -n "$C2" ] && MADE+=("$C2")
[ "$(sess "$C2" | get label)" = "↳ work 2" ] && ok "a second branch is ↳ work 2" \
  || bad "second label: $(sess "$C2" | get label)"
[ "$(sess "$C2" | get pos)" = $((PP + 1)) ] && ok "and the newest branch is the one right under the parent" \
  || bad "second branch at $(sess "$C2" | get pos)"
C3=$(post "branch?id=$C1" | idof); [ -n "$C3" ] && MADE+=("$C3")
[ "$(sess "$C3" | get label)" = "↳ work 3" ] && ok "a branch of a branch is ↳ work 3, not ↳ ↳ work" \
  || bad "branch-of-branch label: $(sess "$C3" | get label)"

# ── review focus 5: the parent's folder is gone ────────────────────────────
mkdir -p "$TMP/gone"
G=$(post "new?cmd=shell&cwd=$TMP/gone" | idof); MADE+=("$G")
goto "$G" "$TMP/gone" || bad "could not put the parent's shell in the doomed folder"
rm -rf "$TMP/gone"
BEFORE=$("$TMUX_BIN" ls -F '#{session_name}' | grep -c '^oneterm_')
R=$(curl -s -w ' %{http_code}' -X POST -H "$O" "$B/branch?id=$G")
AFTER=$("$TMUX_BIN" ls -F '#{session_name}' | grep -c '^oneterm_')
# A wrongly successful branch must still be cleaned up, or it outlives the test.
LEAK=$(printf '%s' "$R" | idof); [ -n "$LEAK" ] && MADE+=("$LEAK")
case "$R" in *no_such_directory*400) ok "a deleted folder is 400 no_such_directory" ;;
  *) bad "deleted folder: $R" ;; esac
[ "$BEFORE" = "$AFTER" ] && ok "…and nothing was created" || bad "a session was created anyway"

# ── claude parent with no conversation yet ─────────────────────────────────
Q=$(post "new?cmd=shell&cwd=$TMP/work" | idof); MADE+=("$Q"); sleep 0.5
"$TMUX_BIN" set-option -t "oneterm_$Q" @oneterm_cmd claude
R=$(curl -s -w ' %{http_code}' -X POST -H "$O" "$B/branch?id=$Q")
case "$R" in *no_conversation*409) ok "a claude tab with no conversation is 409 no_conversation" ;;
  *) bad "no conversation: $R" ;; esac

# ── claude parent with a conversation: the fork command line ───────────────
U=$(uuidgen | tr 'A-Z' 'a-z')
mkdir -p "$TMP/proj"
printf '{"type":"user","sessionId":"%s","cwd":"%s","message":{"role":"user","content":"hi"},"timestamp":"2026-09-29T00:00:00Z"}\n' \
  "$U" "$TMP/work" > "$TMP/proj/$U.jsonl"
curl -s -X POST --data "{\"id\":\"$Q\",\"action\":\"session\",\"claudeSession\":\"$U\",\"transcript\":\"$TMP/proj/$U.jsonl\"}" \
  "$B/agent-event" >/dev/null
"$TMUX_BIN" set-option -t "oneterm_$Q" @oneterm_skip 1
F=$(post "branch?id=$Q" | idof); [ -n "$F" ] && MADE+=("$F")
[ -n "$F" ] && ok "branched a claude tab → $F" || bad "claude branch returned no id"
START=$("$TMUX_BIN" display-message -p -t "oneterm_$F" '#{pane_start_command}')
case "$START" in *"--resume $U --fork-session"*) ok "it runs claude --resume <id> --fork-session" ;;
  *) bad "start command: $START" ;; esac
case "$START" in *--dangerously-skip-permissions*) ok "it inherits the parent's permission mode" ;;
  *) bad "permission mode not inherited: $START" ;; esac
[ "$(opt "$F" @oneterm_skip)" = 1 ] && ok "…and the rail's ! flag with it" || bad "@oneterm_skip not set"
[ "$(sess "$F" | get label)" = "↳ work 4" ] && ok "labelled from the parent, numbered past the shell branches" \
  || bad "claude branch label: $(sess "$F" | get label)"

# ── review focus 1: the first prompt was a big paste ───────────────────────
# The first line carrying a cwd is the first user message. Make it 100KB — past
# the 64KB head read that used to drop it as a fragment and refuse the branch.
U2=$(uuidgen | tr 'A-Z' 'a-z')
BIG=$(head -c 100000 /dev/zero | tr '\0' 'x')
printf '{"type":"user","sessionId":"%s","cwd":"%s","message":{"role":"user","content":"%s"},"timestamp":"2026-09-29T00:00:00Z"}\n' \
  "$U2" "$TMP/work" "$BIG" > "$TMP/proj/$U2.jsonl"
curl -s -X POST --data "{\"id\":\"$Q\",\"action\":\"session\",\"claudeSession\":\"$U2\",\"transcript\":\"$TMP/proj/$U2.jsonl\"}" \
  "$B/agent-event" >/dev/null
H=$(post "branch?id=$Q" | idof); [ -n "$H" ] && MADE+=("$H")
[ -n "$H" ] && ok "a conversation whose first prompt was 100KB still branches" \
  || bad "big-first-prompt conversation was refused"
case "$("$TMUX_BIN" display-message -p -t "oneterm_$H" '#{pane_start_command}' 2>/dev/null)" in
  *"--resume $U2 --fork-session"*) ok "…and it forks the conversation the tab is in NOW (the hook's latest)" ;;
  *) bad "big-prompt branch forked the wrong conversation" ;; esac

# ── a conversation that moved into a worktree mid-session ──────────────────
# Its FIRST cwd is where it started; a `relocated` record and every later line
# carry the worktree, and Claude Code files the transcript under the WORKTREE's
# project folder (the path with every non-alphanumeric turned into '-'). The
# record shapes below are copied from a real relocated transcript. Forking it in
# its first cwd would put the branch in the main checkout — editing main while
# the conversation believes it is in a worktree.
mkdir -p "$TMP/wt"
U3=$(uuidgen | tr 'A-Z' 'a-z')
PROJ="$TMP/$(printf '%s' "$TMP/wt" | sed 's/[^A-Za-z0-9]/-/g')"
mkdir -p "$PROJ"
{
  printf '{"type":"user","sessionId":"%s","cwd":"%s","message":{"role":"user","content":"start"},"timestamp":"2026-09-29T00:00:00Z"}\n' "$U3" "$TMP/work"
  printf '{"type":"relocated","sessionId":"%s","relocatedCwd":"%s"}\n' "$U3" "$TMP/wt"
  printf '{"type":"user","sessionId":"%s","cwd":"%s","message":{"role":"user","content":"later"},"timestamp":"2026-09-29T00:01:00Z"}\n' "$U3" "$TMP/wt"
} > "$PROJ/$U3.jsonl"
curl -s -X POST --data "{\"id\":\"$Q\",\"action\":\"session\",\"claudeSession\":\"$U3\",\"transcript\":\"$PROJ/$U3.jsonl\"}" \
  "$B/agent-event" >/dev/null
W=$(post "branch?id=$Q" | idof); [ -n "$W" ] && MADE+=("$W")
[ "$(opt "$W" @oneterm_cwd)" = "$TMP/wt" ] && ok "a conversation that moved into a worktree is branched IN the worktree" \
  || bad "relocated conversation branched in: $(opt "$W" @oneterm_cwd)"
rm -rf "$TMP/wt"
W2=$(post "branch?id=$Q" | idof); [ -n "$W2" ] && MADE+=("$W2")
[ "$(opt "$W2" @oneterm_cwd)" = "$TMP/work" ] && ok "…and where it started, once that worktree is gone" \
  || bad "relocated-then-removed branched in: $(opt "$W2" @oneterm_cwd)"

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
