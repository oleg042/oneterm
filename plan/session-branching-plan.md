# Session Branching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Branch any oneterm session into a new tab. A Claude tab is forked
with `claude --resume <id> --fork-session`; a shell tab gets a new shell in the
same folder. Branching is done from a two-click rail button or ⌘⇧B.

**Architecture:** The pure decisions live in a new `branch.mjs` so the tests
run the code that ships: the label, the conversation id from a transcript path,
and the rail order after insertion. `server.mjs` gets a `POST /branch` route.
The route reads the parent from tmux and its conversation from the
already-persisted `hookState`, then refuses or creates. `public/index.html`
gets the button, the arming, the shortcut and `branchSession()`.

**Tech Stack:** Node 20 ESM, tmux, xterm.js, plain inline JS/CSS. Tests are
plain `node` / `bash` scripts using the repo's `ok()` / `bad()` style, with no
test framework.

**Spec:** `plan/session-branching.md`

## Global Constraints

- Work only in the feature worktree (`.claude/worktrees/session-branching`, branch `worktree-session-branching`).
- **Never** touch, stage or commit the uncommitted WIP in the main checkout. Stage with explicit paths only. Never `git add -A` or `git add .`, because `node_modules` is an untracked symlink here.
- Branch label: `↳ <base>`, then `↳ <base> 2`, `3`, … . `<base>` is the parent label with leading `↳ ` stripped. At most 60 chars. The tmux row delimiter `|~|` becomes `/`.
- The conversation id is validated with `/^[0-9a-fA-F-]{8,64}$/`, the same regex `/new` uses. From now on there is one shared constant.
- A branch inherits the parent's permission mode (`@oneterm_skip`).
- Error codes: `no_such_session` (404), `no_conversation` (409), `no_such_directory` (400).
- Toast copy:
  - `no_conversation`: "nothing to branch yet — send this session a message first"
  - `no_such_directory`: "that folder is gone: <cwd>"
  - otherwise: "couldn't branch that session"
- The branch button always takes two clicks (it arms for 3 s, shared with ×). ⌘ on the confirming click opens the branch in a new browser tab. ⌘⇧B has no arming step.
- The comment style matches the file: explain *why*, in full sentences, where the decision is made.

## Review Focus

1. **A conversation whose first prompt was a big paste.** Measured on this machine: 16 of 170 transcripts have a first cwd-bearing line of 71–165 KB. The fixed 64 KB head read drops that line as a fragment, so `readConversation` returns null. Branching would then refuse with `no_conversation` (and the resume picker already hides those conversations). Expected: it branches. Pinned by Task 2, Step 3g plus the "big first prompt" case in `e2e-branch.sh`.
2. **Clicking the branch button starts a drag.** `beginDrag` pointer-captures every pointerdown that is not on `.x`, so a click on the new button would reach the row and switch tabs. Expected: the click arms the button, and the row does not switch. Pinned by Task 3, Step 5a.
3. **Holding ⌘⇧B, or pressing it twice fast, creates several branches.** Key repeat fires keydown again and again. Expected: one branch per deliberate press. Pinned by Task 3, Step 5c.
4. **Awkward labels.** Three cases:
   - A 60-char label must not produce a branch label over the cap.
   - A label containing `|~|` would make `listSessions` drop the row as malformed, so the branch would silently vanish.
   - An unrelated tab may already hold the label, for example one you renamed `↳ api` yourself.

   Expected: a valid, capped, unused label. Pinned by Task 1 tests.
5. **The parent's folder was deleted while the tab stayed open.** Expected: 400 `no_such_directory`, and no tmux session created. Pinned by Task 2, `e2e-branch.sh`.

---

### Task 1: `branch.mjs`, the pure decisions

**Files:**
- Create: `branch.mjs`
- Create: `test/branch.test.mjs`
- Modify: `bin/reload.sh`, adding a gate block after the agent-state block (around line 74)

**Interfaces:**
- Produces:
  - `export const CONV_ID: RegExp`: `/^[0-9a-fA-F-]{8,64}$/`
  - `export const BRANCH_MARK: string`: `'↳ '`
  - `export function branchLabel(parentLabel: string, taken: Iterable<string>): string`
  - `export function conversationIdFromTranscript(path: unknown): string | null`
  - `export function orderAfter(ids: string[], parentId: string, newId: string): string[]`

- [ ] **Step 1: Write the failing test** in `test/branch.test.mjs`:

```js
/* The pure half of branching a session: what the branch is called, which
 * conversation it forks, and where it lands in the rail. Kept out of server.mjs
 * for the same reason as detect.mjs and agentstate.mjs — the test has to run
 * the decision that ships, not a copy of it.
 *   node test/branch.test.mjs
 */
import { branchLabel, conversationIdFromTranscript, orderAfter, CONV_ID, BRANCH_MARK }
  from '../branch.mjs'

let pass = 0, fail = 0
const ok  = m => { console.log(`  \x1b[32m✓\x1b[0m ${m}`); pass++ }
const bad = m => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); fail++ }
const eq = (got, want, m) => JSON.stringify(got) === JSON.stringify(want)
  ? ok(m) : bad(`${m}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`)

console.log('\noneterm branching\n')

// ── labels ──────────────────────────────────────────────────────────────────
eq(BRANCH_MARK, '↳ ', 'the mark is an arrow every system font has')
eq(branchLabel('oneterm', ['oneterm']), '↳ oneterm', 'first branch takes the plain mark')
eq(branchLabel('oneterm', ['oneterm', '↳ oneterm']), '↳ oneterm 2', 'second branch is numbered')
eq(branchLabel('oneterm', ['oneterm', '↳ oneterm', '↳ oneterm 2']), '↳ oneterm 3', 'and the third')
eq(branchLabel('↳ oneterm', ['oneterm', '↳ oneterm']), '↳ oneterm 2',
   'a branch of a branch strips the mark instead of stacking it')
eq(branchLabel('↳ ↳ oneterm', []), '↳ oneterm', 'however many marks were stacked')
/* Review focus 4: numbering has to skip EVERY label in use, not just the
   parent's own branches — a tab you renamed yourself counts too. */
eq(branchLabel('api', ['api', 'unrelated', '↳ api']), '↳ api 2',
   'a label taken by any tab is skipped')
eq(branchLabel('', []), '↳ session', 'an empty label still yields a usable name')
eq(branchLabel(undefined, []), '↳ session', 'so does a missing one')
/* Review focus 3: the row format is delimiter-separated, so a label holding
   the delimiter makes listSessions drop the row — the branch would exist in
   tmux and never appear in the rail. And rename caps labels at 60. */
eq(branchLabel('a|~|b', []), '↳ a/b', 'the tmux row delimiter cannot survive into a label')
const long = 'x'.repeat(60)
const l1 = branchLabel(long, [])
l1.length <= 60 ? ok('a 60-char parent still yields a label within the cap')
                : bad(`label is ${l1.length} chars`)
const l2 = branchLabel(long, [l1])
l2.length <= 60 && l2 !== l1 && l2.endsWith(' 2')
  ? ok('…and so does its numbered sibling, with the number intact')
  : bad(`numbered long label: ${JSON.stringify(l2)}`)

// ── which conversation ──────────────────────────────────────────────────────
const U = '2979b8e9-3285-4dc0-9548-b1553aa5b2de'
eq(conversationIdFromTranscript(`/Users/x/.claude/projects/-a-b/${U}.jsonl`), U,
   'the id comes from the filename, which Claude Code names after the session')
eq(conversationIdFromTranscript(`/x/${U}.json`), null, 'only a .jsonl transcript counts')
eq(conversationIdFromTranscript('/x/$(rm -rf ~).jsonl'), null,
   'anything but the id shape is refused — it reaches a command line')
eq(conversationIdFromTranscript(''), null, 'empty is no conversation')
eq(conversationIdFromTranscript(undefined), null, 'missing is no conversation')
eq(conversationIdFromTranscript(42), null, 'a non-string is no conversation')
CONV_ID.test(U) && !CONV_ID.test('abc') && !CONV_ID.test(U + ';x')
  ? ok('CONV_ID accepts the shape Claude Code mints and nothing looser')
  : bad('CONV_ID shape')

// ── where it lands ──────────────────────────────────────────────────────────
eq(orderAfter(['a', 'p', 'b'], 'p', 'n'), ['a', 'p', 'n', 'b'], 'directly under its parent')
eq(orderAfter(['a', 'b', 'p'], 'p', 'n'), ['a', 'b', 'p', 'n'], 'parent at the bottom')
eq(orderAfter(['n', 'a', 'p', 'b'], 'p', 'n'), ['a', 'p', 'n', 'b'],
   'a branch already in the list (createSession put it on top) is moved, not duplicated')
eq(orderAfter(['a', 'b'], 'gone', 'n'), ['n', 'a', 'b'],
   'a parent that vanished meanwhile puts the branch on top, like any new tab')

console.log(`\n  ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
console.log('  branching decisions hold.\n')
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node test/branch.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND ... branch.mjs`

- [ ] **Step 3: Write `branch.mjs`**

```js
/* Branching a session — the decisions, kept pure so test/branch.test.mjs runs
 * the code that ships (the same arrangement as detect.mjs and agentstate.mjs).
 *
 * A branch is a new tab holding a copy of an existing one: a Claude
 * conversation forked with `claude --resume <id> --fork-session`, or a fresh
 * shell in the same folder. server.mjs owns tmux and the filesystem; this
 * module only answers "what is it called", "which conversation" and "where
 * does it go". */

/* The shape Claude Code mints for a session id. It reaches a command line, so
   it is matched exactly and nothing looser — anything else would be shell
   injection with extra steps. /new validates --resume with this too. */
export const CONV_ID = /^[0-9a-fA-F-]{8,64}$/

/* ↳, not ⑂: the branch glyph is missing from enough system fonts to render as
   a box, and "child of the row above" is exactly what the arrow says — the
   branch is placed directly under its parent. */
export const BRANCH_MARK = '↳ '

const MAX_LABEL = 60                 // what /rename allows
const DELIM = '|~|'                  // listSessions' row delimiter

/**
 * `↳ <base>`, or `↳ <base> N` for the first N ≥ 2 not already in use.
 * `taken` is EVERY label in the rail, not just this parent's branches: a tab
 * you renamed yourself can hold the name too, and two tabs sharing a label is
 * how a rename turns into a guessing game.
 */
export function branchLabel(parentLabel, taken) {
  const used = new Set(taken)
  // Strip the mark rather than stack it: a branch of a branch is still a
  // branch of the same work, and "↳ ↳ ↳ api" says nothing "↳ api 3" does not.
  const base = String(parentLabel ?? '')
    .split(DELIM).join('/')
    .replace(/^(↳\s*)+/, '')
    .trim() || 'session'
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? '' : ' ' + n
    // Trim the BASE, never the number — "↳ very-long-na" and its sibling
    // must still be told apart.
    const room = MAX_LABEL - BRANCH_MARK.length - suffix.length
    const label = BRANCH_MARK + base.slice(0, room).trimEnd() + suffix
    if (!used.has(label)) return label
  }
}

/**
 * The conversation a transcript belongs to, from its FILENAME.
 *
 * Claude Code names every transcript <session id>.jsonl, and that name is the
 * one thing guaranteed to be this session's own. Returns null for anything
 * that is not a .jsonl named with a valid id.
 */
export function conversationIdFromTranscript(path) {
  if (typeof path !== 'string' || !path.endsWith('.jsonl')) return null
  const id = path.slice(path.lastIndexOf('/') + 1, -'.jsonl'.length)
  return CONV_ID.test(id) ? id : null
}

/**
 * The rail order with `newId` directly after `parentId`.
 *
 * createSession has already put the new tab on top of the rail, so `ids` may
 * contain it — it is moved, never duplicated. If the parent vanished between
 * the check and now, the branch stays on top like any other new tab.
 */
export function orderAfter(ids, parentId, newId) {
  const rest = ids.filter(x => x !== newId)
  const at = rest.indexOf(parentId)
  if (at < 0) return [newId, ...rest]
  return [...rest.slice(0, at + 1), newId, ...rest.slice(at + 1)]
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node test/branch.test.mjs`
Expected: every line ✓, ending `branching decisions hold.`, exit 0.

- [ ] **Step 5: Add it to the reload gate.** In `bin/reload.sh`, directly after the agent-state block (the `echo "  agent-state tests pass …"` line), insert:

```bash
# Branching decides a label that lands in the tmux row format and an id that
# lands on a command line. Both are pure, so both are gated here.
if ! node "$DIR/test/branch.test.mjs" >/tmp/oneterm-branch.log 2>&1; then
  echo
  echo "✗ branching tests FAILED — NOT restarting."
  sed 's/^/  /' /tmp/oneterm-branch.log | tail -25
  exit 1
fi
echo "  branching tests pass ($(grep -c '✓' /tmp/oneterm-branch.log) checks)"
```

Run: `bash -n bin/reload.sh`
Expected: no output, exit 0. Do NOT run `reload.sh` itself: it restarts the live host on :7331 from the main checkout.

- [ ] **Step 6: Commit**

```bash
git add branch.mjs test/branch.test.mjs bin/reload.sh
git commit -m "branch.mjs: what a branch is called, which conversation, and where it lands"
```

---

### Task 2: the host route, `POST /branch`

**Files:**
- Modify: `server.mjs`:
  - imports (around line 32)
  - `CONV_HEAD` and `readConversation` (around lines 418-457)
  - `createSession` (around line 513; lines 519-521 and 581-582)
  - `json` helper (around line 808)
  - `MUTATIONS` (around line 834)
  - `/reorder` (around line 984)
  - `/new` (around lines 1011-1031)
- Create: `test/e2e-branch.sh`

**Interfaces:**
- Consumes: `branchLabel`, `conversationIdFromTranscript`, `orderAfter`, `CONV_ID` from Task 1. Existing: `listSessions()`, `hookState`, `readConversation(path, mtime)`, `isDir(path)`, `createSession(opts)`, `tmux(args)`.
- Produces: `POST /branch?id=<parent>&cols=<n>&rows=<n>`
  - Success: `200 {id}`
  - Failures: `404 {error:'no_such_session'}`, `409 {error:'no_conversation'}`, `400 {error:'no_such_directory', cwd}`
  - `createSession({ …, fork?: boolean, label?: string })`
  - `writeOrder(ids: string[])`

- [ ] **Step 1: Write the failing end-to-end test** `test/e2e-branch.sh`:

```bash
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
mkdir -p "$TMP/work"
P=$(post "new?cmd=shell&cwd=$TMP/work" | idof); MADE+=("$P")
[ -n "$P" ] && ok "created a shell parent $P" || { bad "could not create a parent"; exit 1; }
sleep 0.5

C1=$(post "branch?id=$P" | idof); [ -n "$C1" ] && MADE+=("$C1")
[ -n "$C1" ] && ok "branched it → $C1" || bad "branching a shell returned no id"
PP=$(sess "$P" | get pos); CP=$(sess "$C1" | get pos)
[ "$CP" = $((PP + 1)) ] && ok "the branch sits directly under its parent" \
  || bad "branch at $CP, parent at $PP"
[ "$(sess "$C1" | get label)" = "↳ work" ] && ok "labelled ↳ work" \
  || bad "label: $(sess "$C1" | get label)"
[ "$(sess "$C1" | get cmd)" = "shell" ] && ok "a shell branches into a shell" \
  || bad "cmd: $(sess "$C1" | get cmd)"
[ "$(sess "$C1" | get cwd)" = "$TMP/work" ] && ok "in the parent's live folder" \
  || bad "cwd: $(sess "$C1" | get cwd)"

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
G=$(post "new?cmd=shell&cwd=$TMP/gone" | idof); MADE+=("$G"); sleep 0.5
rm -rf "$TMP/gone"
BEFORE=$("$TMUX_BIN" ls -F '#{session_name}' | grep -c '^oneterm_')
R=$(curl -s -w ' %{http_code}' -X POST -H "$O" "$B/branch?id=$G")
AFTER=$("$TMUX_BIN" ls -F '#{session_name}' | grep -c '^oneterm_')
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

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
```

Note on `↳ work 4`: parent `Q` is labelled `work` (its cwd basename), and `↳ work`, `↳ work 2` and `↳ work 3` are already taken, so it gets 4. That is review focus 4 working across unrelated parents.

- [ ] **Step 2: Start a worktree host on 7332 and watch the test fail**

The worktree host shares the real tmux server and `~/.oneterm/agent-state.json` with the live host. That is safe: both hosts see the same sessions, and the live host only reads that file at boot.

Run it in the background with the Bash tool (`run_in_background: true`):
`PORT=7332 node server.mjs > "$SCRATCH/host7332.log" 2>&1`
Here `$SCRATCH` is the session scratchpad. Then:

Run: `PORT=7332 bash test/e2e-branch.sh`
Expected: only the foreign-Origin check passes, because the guard predates the route. `GET /branch` returns 404 (static fallthrough), not 405. Every branch line FAILS, and the script exits non-zero.

- [ ] **Step 3: Implement the route.** Seven edits to `server.mjs`, (a)–(g):

(a) Imports, after the `agentstate.mjs` import:

```js
// What a branch is called, which conversation it forks and where it lands —
// pure, so test/branch.test.mjs runs the decisions that ship.
import { branchLabel, conversationIdFromTranscript, orderAfter, CONV_ID } from './branch.mjs'
```

(b) `createSession`: take `fork` and `label`. Change the signature to:

```js
async function createSession({ id, cmd, cwd, cols, rows, skip, resume, fork, label }) {
```

Change the `claudeCmd` block to:

```js
  const claudeCmd = 'claude'
    + (skip ? ' --dangerously-skip-permissions' : '')
    + (resume ? ` --resume ${resume}` : '')
    /* A BRANCH: the same conversation under a new session id, so the two tabs
       diverge from here and neither writes into the other's transcript. */
    + (resume && fork ? ' --fork-session' : '')
```

Replace the two label lines
`const label = cwd.split('/').filter(Boolean).pop() || '~'` and
`await tmux(['set-option', '-t', name, '@oneterm_label', label])` with:

```js
  const tabLabel = label || cwd.split('/').filter(Boolean).pop() || '~'
  await tmux(['set-option', '-t', name, '@oneterm_label', tabLabel])
```

(c) The `json` helper takes a status, because the branch route has three refusals:

```js
const json = (res, body, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
```

(d) `MUTATIONS` gains `'/branch'`:

```js
const MUTATIONS = new Set(['/new', '/kill', '/rename', '/reorder', '/drop', '/clientlog',
                           '/agent-event', '/branch'])
```

(e) `/reorder` goes through one writer, so a drag and a branch space orders the same way. Add this function just above `const server = createServer(`:

```js
/* The rail order is @oneterm_order on each session, spaced by ten. One writer,
   so a drag and a branch cannot disagree about what the spacing means. */
async function writeOrder(ids) {
  for (let i = 0; i < ids.length; i++)
    await tmux(['set-option', '-t', PREFIX + ids[i], '@oneterm_order', String(i * 10)])
}
```

Then replace the loop body in `/reorder`:

```js
  if (p === '/reorder') {
    await writeOrder((url.searchParams.get('ids') || '').split(',').filter(Boolean))
    return json(res, { ok: true })
  }
```

(f) `/new` uses the shared id shape. Replace `!/^[0-9a-fA-F-]{8,64}$/.test(resume)` with `!CONV_ID.test(resume)`. Then add the route directly after the `/new` block's closing `}`:

```js
  /* A branch: a new tab holding a copy of an existing one. A Claude tab is
   * forked — `claude --resume <id> --fork-session`, the conversation's own
   * cwd, the parent's permission mode — and a shell tab gets a fresh shell in
   * the same live folder. Every refusal happens BEFORE anything is created, so
   * a failed branch never leaves a half-made tab in the rail. */
  if (p === '/branch') {
    const q = url.searchParams
    const list = await listSessions()
    const parent = list.find(s => s.id === q.get('id'))
    if (!parent) return json(res, { error: 'no_such_session' }, 404)

    let cwd = parent.cwd, resume = null
    if (parent.cmd === 'claude') {
      /* The hook stamps the transcript on every turn and on SessionStart —
         including the one /clear fires — so this names the conversation the
         tab is in NOW. The id comes from the filename and the cwd from the
         file: `claude --resume` finds a conversation by its project folder,
         so the tab's live path would be the wrong question. */
      const transcript = hookState.get(parent.id)?.transcript
      resume = conversationIdFromTranscript(transcript)
      const conv = resume ? await readConversation(transcript, 0) : null
      if (!conv) return json(res, { error: 'no_conversation' }, 409)
      cwd = conv.cwd
    }
    if (!(await isDir(cwd))) return json(res, { error: 'no_such_directory', cwd }, 400)

    const id = 's' + Date.now().toString(36)
    await createSession({ id, cmd: parent.cmd, cwd,
      cols: Number(q.get('cols')), rows: Number(q.get('rows')),
      skip: parent.skip, resume, fork: true,
      label: branchLabel(parent.label, list.map(s => s.label)) })
    // createSession put it on top; a branch belongs under the tab it came from.
    await writeOrder(orderAfter(list.map(s => s.id), parent.id, id))
    console.log(`[branch] ${parent.id} -> ${id}` + (resume ? ` (fork of ${resume})` : ' (shell)'))
    return json(res, { id })
  }
```

(g) `readConversation` grows its head read until it can place the conversation. Next to `const CONV_HEAD  = 64 * 1024`, add:

```js
const CONV_HEAD_MAX = 4 * 1024 * 1024  // …grown ×4 up to this, see readConversation
```

In `readConversation`, replace everything from
`const { buffer, bytesRead } = await fh.read(Buffer.alloc(CONV_HEAD), 0, CONV_HEAD, 0)`
through the end of the `for (const line of lines) { … }` loop with:

```js
    /* The head GROWS until it holds a complete line with the cwd. A fixed 64KB
       missed 16 of 170 real conversations on one machine: the first line that
       carries a cwd is the first user message, and a pasted prompt made that
       single line 71–165KB — cut off by the read, dropped as a fragment, and
       the conversation could not be placed. It vanished from the resume
       picker, and a branch of it was refused as "nothing to branch". Only a
       file that has not yet produced id+cwd pays for a bigger read. */
    let cwd = null, title = null, id = null, firstUser = null
    for (let size = CONV_HEAD; ; size *= 4) {
      const { buffer, bytesRead } = await fh.read(Buffer.alloc(size), 0, size, 0)
      // The last line of a bounded read is usually truncated — drop it.
      const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n'); lines.pop()
      // Re-scanning from the top on a bigger read is harmless: every field is ??=.
      for (const line of lines) {
        let d; try { d = JSON.parse(line) } catch { continue }
        id    ??= d.sessionId
        cwd   ??= d.cwd
        title ??= d.customTitle
        if (!firstUser && d.type === 'user') {
          const c = d.message?.content
          const t = typeof c === 'string' ? c
                  : Array.isArray(c) ? c.filter(x => x?.type === 'text').map(x => x.text).join(' ')
                  : ''
          if (t.trim()) firstUser = t.trim().replace(/\s+/g, ' ').slice(0, 120)
        }
        if (id && cwd && title && firstUser) break
      }
      if ((id && cwd) || bytesRead < size || size >= CONV_HEAD_MAX) break
    }
```

The next line, `if (!id || !cwd) return null`, stays as it is.

The resume picker gains the same fix, since it reads through the same function.

- [ ] **Step 4: Restart the worktree host and run the test**

Stop the background 7332 host (TaskStop, or `kill` its pid from `curl -s localhost:7332/health`). Check the syntax with `node --check server.mjs`, then start it again as in Step 2.

Run: `PORT=7332 bash test/e2e-branch.sh`
Expected: every line ✓, `0 failed`, exit 0.
Run: `node test/branch.test.mjs && node test/agentstate.test.mjs && node test/detect.test.mjs`
Expected: all pass. `/reorder` and `/new` changed shape but not behaviour.

- [ ] **Step 5: Commit**

```bash
git add server.mjs test/e2e-branch.sh
git commit -m "POST /branch: fork a Claude tab or duplicate a shell, directly under its parent"
```

---

### Task 3: the rail button, ⌘⇧B, and the docs

**Files:**
- Modify: `public/index.html`:
  - `.sess` padding (around line 90) and the `.sess .x` rules (around lines 129-134)
  - the footer hint (around line 413)
  - `beginDrag` (around line 856)
  - `paintRail`'s kill button (around lines 1094-1110)
  - after `newSession` (around line 1188)
  - the keydown handler (around line 1449)
- Modify: `README.md`, the "What it does" and "Development" sections

**Interfaces:**
- Consumes: `POST /branch` from Task 2. Existing client helpers: `post(p)`, `refresh()`, `paintRail()`, `connect(id)`, `writeHash(id)`, `toast(msg, ms)`, `term`, `active`, `armedKill`, `armTimer`.
- Produces: `branchSession(id: string, { newTab?: boolean }): Promise<void>` and the global `armedBranch: string | null`.

- [ ] **Step 1: CSS.** In the `.sess{…}` rule, change `padding:9px 22px 9px 12px` to `padding:9px 12px`. Then replace the four `.sess .x…` rules with:

```css
/* Branch and close share the card's top-right corner, branch on the left.
   They used to sit vertically centred, which put a button across the path
   line — and the context percent lives at that line's right end. Only the
   title line makes room for them now, so the path line gets its width back. */
.sess .t{padding-right:34px}
.sess .x,.sess .br{cursor:pointer;position:absolute;top:5px;opacity:0;
  width:18px;height:18px;display:grid;place-items:center;border-radius:3px;
  color:var(--faint);font-size:14px;line-height:1;transition:opacity var(--sp) var(--ease)}
.sess .x{right:5px}
.sess .br{right:25px}
.sess .br svg{width:11px;height:11px}
.sess:hover .x,.sess:hover .br{opacity:1}
.sess .x:hover{color:var(--err);background:var(--paper)}
.sess .br:hover{color:var(--accent);background:var(--paper)}
.sess .x.armed{opacity:1;color:var(--sink);background:var(--err);font-size:11px}
.sess .br.armed{opacity:1;color:var(--sink);background:var(--accent);font-size:11px}
```

- [ ] **Step 2: Arming and the button.** Change the globals line
`let dragId = null, armedKill = null, armTimer = null, lastSig = '', renaming = false` to:

```js
let dragId = null, armedKill = null, armedBranch = null, armTimer = null, lastSig = '', renaming = false
/* The rail's branch glyph. SVG rather than a character: the fork symbols in
   Unicode are missing from enough fonts to render as an empty box. */
const BRANCH_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" ' +
  'stroke-linecap="round"><circle cx="4.5" cy="3" r="1.6"/><circle cx="4.5" cy="13" r="1.6"/>' +
  '<circle cx="11.5" cy="5" r="1.6"/><path d="M4.5 4.6v6.8M11.5 6.6c0 3.2-7 2.2-7 4.8"/></svg>'
```

In `beginDrag`, change the guard line to:

```js
  if (e.target.closest('.x') || e.target.closest('.br') || e.target.closest('input')) return   // row buttons, rename field
```

In `paintRail`, change the kill button's arming lines. The `if (s.cmd === 'claude' && !armed){ … }` body becomes:

```js
      if (s.cmd === 'claude' && !armed){
        armedKill = s.id; armedBranch = null; paintRail()
        clearTimeout(armTimer); armTimer = setTimeout(() => { armedKill = armedBranch = null; paintRail() }, 3000)
        return
      }
```

Then replace `el.appendChild(x); box.appendChild(el)` with:

```js
    /* Branch: ALWAYS two clicks, for shells too. It creates a tab rather than
       destroying one, but a stray click still costs a tab you then have to
       close, and the first click is where the ⌘ hint gets read. ⌘ on the
       confirming click opens the branch in a new browser tab instead. */
    const br = document.createElement('span')
    const brArmed = armedBranch === s.id
    br.className = 'br' + (brArmed ? ' armed' : '')
    br.innerHTML = brArmed ? '✓' : BRANCH_ICON
    br.title = brArmed ? 'click again to branch — ⌘-click opens it in a new tab'
                       : 'branch this session (⌘⇧B)'
    br.onclick = e => {
      e.stopPropagation()
      if (!brArmed){
        armedBranch = s.id; armedKill = null; paintRail()
        clearTimeout(armTimer); armTimer = setTimeout(() => { armedKill = armedBranch = null; paintRail() }, 3000)
        return
      }
      armedBranch = null; clearTimeout(armTimer)
      branchSession(s.id, { newTab: e.metaKey || e.ctrlKey })
    }
    el.appendChild(br); el.appendChild(x); box.appendChild(el)
```

- [ ] **Step 3: `branchSession`.** Insert directly after `newSession`'s closing `}`:

```js
/* The host decides what a branch is — forked conversation or fresh shell — and
   refuses before creating anything, so a toast is the only failure path here.
   `branching` makes a double confirm or a held ⌘⇧B one branch, not several. */
let branching = false
async function branchSession(id, { newTab = false } = {}){
  if (!id || branching) return
  branching = true
  try {
    const r = await post('/branch?id=' + encodeURIComponent(id) +
      '&cols=' + term.cols + '&rows=' + term.rows)
    if (!r?.id){
      toast(r?.error === 'no_conversation' ? 'nothing to branch yet — send this session a message first'
          : r?.error === 'no_such_directory' ? 'that folder is gone: ' + tilde(r.cwd || '')
          : "couldn't branch that session", 4200)
      return
    }
    hideOverlay(); await refresh()
    if (newTab){
      paintRail()
      /* Opened after an await, which Chrome allows for a few seconds after
         the click. If it refuses anyway, the branch still exists — say where. */
      const url = location.origin + location.pathname + location.search + '#' + encodeURIComponent(r.id)
      if (!window.open(url, '_blank')) toast('branched — the browser blocked the new tab, so it is in the rail', 4200)
      return
    }
    active = r.id; localStorage.setItem('oneterm-active', r.id); writeHash(r.id)
    paintRail(); connect(r.id)
  } finally { branching = false }
}
```

- [ ] **Step 4: ⌘⇧B and the footer.** In the global keydown handler, insert directly before `if (meta && /^[1-9]$/.test(e.key)){`:

```js
  /* ⌘⇧B branches the session you are in. Shift for the same reason as ⌘⇧R,
     and no arming step: a three-key chord is not a stray click. e.repeat,
     because holding the chord fires keydown over and over. */
  if (meta && e.shiftKey && e.key.toLowerCase() === 'b'){ e.preventDefault()
    if (!e.repeat && active){ closeSheet(); branchSession(active) }; return }
```

Change the footer's `<span>double-click a session to rename</span>` to:

```html
    <span><kbd>&#8984;&#8679;B</kbd> branch &middot; double-click a session to rename</span>
```

Run the same parse check `reload.sh` uses:

```bash
node -e '
  const h = require("fs").readFileSync("public/index.html", "utf8")
  const m = h.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/)
  new Function(m[1]); console.log("client script parses")'
```

Expected: `client script parses`.

- [ ] **Step 5: Drive it in a real browser (Playwright MCP) against the worktree host on 7332**

Never open the page without a `#hash`. The page would attach to the top session in the rail, and `window-size latest` would resize the pane the user is watching — including the session running this very work. First make a scratch parent:
`S=$(curl -s -X POST -H 'Origin: http://127.0.0.1:7332' 'http://127.0.0.1:7332/new?cmd=shell&cwd=/tmp' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')`
Then navigate to `http://localhost:7332/#$S`.

- **a (review focus 1):** Hover `S`'s row and click `.br`. Expected: it shows ✓ with `.armed`, the active row is still `S`, and no drag starts. Take a screenshot of the corner buttons for the user.
- **b:** Click the armed `.br` again. Expected: a new row `↳ tmp` appears directly under `S` and is active, and the URL hash is its id.
- **c (review focus 2):** Press `Meta+Shift+B` via `keyboard.down`, press `B` down again (a repeat), then release. Expected: exactly ONE new branch of the active session, `↳ tmp 2`. Check it by counting rows before and after.
- **d:** Arm `.br` on `S`, then ⌘-click it (`click` with `modifiers: ['Meta']`). Expected: a popup page opens on `#<new id>`, and the original page's active row is unchanged.
- **e:** Make one real Claude branch: hover the row of any **claude** session that has a conversation and confirm its `.br`. Expected: a `↳ <label>` row under it, which Claude Code opens on that conversation's history. The page switches to the BRANCH, never attaching the parent.
- **f:** Arm × on a row, then click `.br` on the same row. Expected: × disarms, so there is never a double ✓.

Then kill every session this step made (`POST /kill?id=…`, with the Origin header).

- [ ] **Step 6: README.** Under "What it does", after the resume bullet, add:

```markdown
- **Branch any session** — the branch button on a tab (click twice), or
  ⌘⇧B, forks the conversation into a new tab right under it. The original is
  never touched; press Esc Esc in the branch to rewind it further back.
```

Under "Development", after the `agentstate.test.mjs` line, add:

```sh
node test/branch.test.mjs        # branch labels, fork ids, rail placement
bash test/e2e-branch.sh          # /branch against the running host
```

- [ ] **Step 7: Commit**

```bash
git add public/index.html README.md
git commit -m "branch a session from the rail (two clicks) or ⌘⇧B"
```

---

### Task 4: hand-off

- [ ] **Step 1:** Stop the 7332 host. Confirm `tmux ls | grep -c oneterm_` matches the count from before testing, meaning no scratch sessions are left.
- [ ] **Step 2:** Mark the spec as built: change `Status: approved design, not yet built.` to `Status: built.` in `plan/session-branching.md`, then commit that path alone.
- [ ] **Step 3:** Use superpowers:finishing-a-development-branch. **The merge needs care:** `main` has uncommitted WIP in `server.mjs`, `public/index.html` and `package*.json`, so a plain merge into that checkout will refuse to run. Offer the user the options, and do not stash their work without asking.
