# oneterm — branching a session

Written 2026-09-29. Status: approved design, not yet built.

---

## What it is for

You are deep in a Claude Code session and want to try a different direction
without giving up the one you are in. A **branch** is a new tab that starts
with the same conversation history and then goes its own way. The original is
never touched, including when it is in the middle of a turn.

Branching happens from the **current point**. To branch from an earlier point,
branch and then press Esc Esc in the new tab: that is Claude Code's own rewind,
and it works on the copy without affecting the original. A picker for earlier
messages in oneterm itself was considered and rejected. It would mean parsing
and trimming Claude Code's JSONL, which is roughly three times the work, and it
would break whenever that format changes.

## How you use it

| Gesture | Result |
|---|---|
| Click the **branch button** on a rail row | Arms it: the glyph turns into ✓ for 3 s |
| Click it again while armed | Branches that row's session and switches to the branch |
| **⌘-click** it while armed | Branches, and opens the branch in a new browser tab (`/#<id>`) while this window stays where it is |
| **⌘⇧B** | Branches the active session and switches to it, with no arming step |

- The branch button sits **immediately left of ×**. Both buttons move from
  vertically centred to the **top-right corner** of the card, and both appear
  on hover as × does today.
- The branch button always needs the second click, for shell and Claude tabs
  alike. × keeps its current rule: armed only for Claude tabs.
- Arming one button disarms the other, so the row never shows two ✓ at once.
- There is no arming step for ⌘⇧B, because a three-key chord is not pressed by
  accident. Chrome does not reserve ⌘⇧B (it toggles the bookmarks bar), so the
  page can take it over.
- The branch is placed **directly under its parent** in the rail and is
  labelled `↳ <parent label>`. When that label is already taken it becomes
  `↳ <parent label> 2`, then `3`, and so on. A branch of a branch strips the
  parent's leading `↳ ` before applying the same rule. `↳` is used rather than
  `⑂` because every system font has it. Renaming still works by double-click.

## What a branch is

| Parent | Branch |
|---|---|
| Claude tab | `claude --resume <conversation id> --fork-session`, in the conversation's own cwd, with the parent's permission mode |
| Shell tab | A new login shell in the parent's live cwd (`pane_current_path`) |
| Claude tab whose claude exited (now `cmd=shell`) | Treated as a shell tab. `claude --continue` still works inside it |

`--fork-session` is native to Claude Code (verified on 2.1.284). It copies the
conversation under a new session id and leaves the original file alone.

**Permission mode is inherited.** If the parent runs with
`--dangerously-skip-permissions`, so does the branch. That is server state,
chosen by you for that session, so it does not conflict with the existing rule
that the browser must never decide it.

## Host (`server.mjs`)

### `POST /branch?id=<parent>&cols=<n>&rows=<n>`

It is added to `MUTATIONS`, so it gets the POST-only, Host and Origin checks
every other state change has.

1. Find the parent in `listSessions()`. If it is missing, return **404**
   `no_such_session`.
2. **Claude parent:**
   1. `transcript = hookState.get(id)?.transcript`. The hook updates this on
      every non-status event, including `SessionStart` after `/clear`, so it
      names the conversation the tab is in now.
   2. **The conversation id comes from the transcript's filename**
      (`<id>.jsonl`), never from its contents. Claude Code always names the
      file after the session. The contents are not reliable: a forked file may
      still carry the parent's `sessionId` on copied lines, and then a branch
      of a branch would fork the grandparent. The id is validated against the
      same `/^[0-9a-fA-F-]{8,64}$/` that `/new` uses, because it reaches a
      command line.
   3. **The cwd comes from the transcript**, via the existing
      `readConversation`, as resume already does. `claude --resume` looks the
      conversation up by project folder, so the parent's live path is the
      wrong input.
   4. If there is no transcript, the file does not exist yet, or it cannot be
      placed, return **409** `no_conversation`. This happens before the first
      message is sent, or when the hooks are not installed.
3. **Shell parent:** the cwd is `parent.cwd`, which `listSessions` already
   resolves to the live path.
4. If the cwd is gone, return **400** `no_such_directory`.
5. `createSession({ id, cmd, cwd, cols, rows, skip: parent.skip, resume, fork: true, label })`.
6. Place the new session directly after its parent and rewrite the rail order.
7. Return `{ id }`.

Nothing is created until every check above has passed, so a refusal never
leaves a half-made session behind.

### Changes to existing code

- `createSession` gets two optional parameters:
  - `fork` appends `--fork-session` when `resume` is set.
  - `label` replaces the cwd-basename default.
- `writeOrder(ids)` is extracted from `/reorder` (which sets
  `@oneterm_order = i * 10`) and used by both routes.

### `branch.mjs`: the pure parts

This follows the `detect.mjs` / `agentstate.mjs` pattern: tests run the code
that ships.

- `branchLabel(parentLabel, takenLabels)` returns the `↳ x`, `↳ x 2`, …
  label.
- `conversationIdFromTranscript(path)` returns the id, or `null` if the
  filename is not a valid id.
- `orderAfter(ids, parentId, newId)` returns the new rail order with `newId`
  immediately after `parentId`. If the parent is not in `ids`, `newId` goes
  first.

## Client (`public/index.html`)

- `branchSession(id, { newTab })` POSTs `/branch`.
  - On error, a toast per error code:
    - `no_conversation`: "nothing to branch yet — send this session a message first"
    - `no_such_directory`: "that folder is gone"
    - anything else: "couldn't branch that session"
  - On success with `newTab`: refresh the rail, then
    `window.open(origin + '/#' + id)`. Page load already resolves the hash.
  - On success otherwise: the same tail as `newSession`, which makes the
    branch active, writes the hash and connects.
- Rail row: a `.br` button before `.x`. It is armed through `armedBranch`,
  which mirrors `armedKill` and shares `armTimer`. Both buttons are
  top-right anchored.
- Global keydown: `meta && shift && b` branches `active`.

## Known limits

- **Two `claude` processes in one tmux session.** This is rare: a second window,
  or a script that shells out. The branch forks whichever of them reported most
  recently.
- **Branching mid-turn** copies the history written to disk so far. The
  original keeps running. Claude Code already resumes interrupted
  conversations, which is the same situation it recovers from after a crash.
- **Hooks not installed** means Claude tabs cannot be branched: they return
  `no_conversation`. Shell tabs still can.

## Verification

- `test/branch.test.mjs` covers the three pure functions and is added to
  `bin/reload.sh`'s gate.
- One real fork (`claude -p --resume <id> --fork-session`) to record what
  `--fork-session` writes to disk. If the forked file carries the parent's
  `sessionId`, `readConversation` switches to preferring the filename too.
  Without that, the resume picker would reopen the parent when you pick the
  branch.
- End-to-end in the real app, on a second host on port 7332 run from this
  worktree:
  - arm, then confirm
  - ⌘-click opens a new tab
  - ⌘⇧B
  - a shell branch
  - `no_conversation` on a fresh tab
  - the branch sits under its parent with the right label
  - the parent is unchanged
