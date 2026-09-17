# oneterm - Everything you love about the terminal without everything you hate.


[![tests](https://github.com/oleg042/oneterm/actions/workflows/tests.yml/badge.svg)](https://github.com/oleg042/oneterm/actions/workflows/tests.yml)



Your terminal, in a Chrome tab. Built for running several Claude Code sessions
without losing track of them.

It is **local software**, not a web app. There is no server, no account, no
telemetry and nothing leaves your machine. Chrome is only the window.

```
Chrome  ←WebSocket→  host (node)  ←pty→  tmux  ←→  claude
```

Every session is a **tmux** session, so the host owns nothing. It can crash, be
restarted, or be replaced with a new version mid-task and your work is
untouched — tmux is still holding it. `tmux ls` is the only source of truth for
what exists; there is no session list to drift out of sync.

## What it does

- **All your sessions in one rail**, each showing whether it is working, idle,
  or blocked waiting on you — driven by Claude Code's own lifecycle hooks, with
  pane-matching as a fallback.
- **A sound when a session needs you**, so you can leave it alone.
- **Resume any past conversation from any folder** in two keystrokes, sorted by
  when you last actually spoke in it.
- **Context and rate-limit meters** — per-session context fill, plus your
  5-hour and weekly windows and when they reset. All read from Claude Code's
  own status-line data, never inferred.
- **Skill previews** — browse and read every skill and slash command you own.
- Sessions survive `/quit`. If Claude Code exits, the tab stays and becomes a
  shell instead of disappearing.

## Install (macOS)

Requires [tmux](https://github.com/tmux/tmux) (`brew install tmux`), Node 20+,
and [Claude Code](https://claude.com/claude-code).

```sh
git clone https://github.com/oleg042/oneterm.git
cd oneterm
npm install
bash bin/install.sh          # LaunchAgent + /Applications/oneterm.app
node bin/install-hooks.mjs   # session-state hooks + status line
open http://localhost:7331
```

`bin/install-hooks.mjs` edits `~/.claude/settings.json`. It merges rather than
overwrites: other tools' hooks are preserved, your existing status line is
**wrapped, not replaced**, and one backup is taken before the first change.
`node bin/install-hooks.mjs --uninstall` puts everything back.

## Other platforms

**WSL** — close. The host is already portable; `bin/install.sh` is the
macOS-specific part (LaunchAgent and `.app` bundle). Replace it with any way of
keeping `node server.mjs` running, then open `localhost:7331` in Windows
Chrome. Note `node-pty` has no prebuilt Linux binary, so it compiles on install
— you need `build-essential` and `python3`.

**Native Windows** — a real piece of work, and the interesting open problem
here. Windows can do the terminal part (`node-pty` ships ConPTY builds). What
it has no answer for is tmux, which is the thing that keeps a session alive
when the host dies. That substrate would need replacing — most likely a
headless terminal daemon holding the buffers. PRs very welcome.

### Pointing an agent at this

If you are reading this as Claude Code and someone asked you to get oneterm
running on their machine: read `server.mjs` first — the header explains the
architecture and most non-obvious decisions are commented where they were
made. `bin/install.sh` is the part most likely to need changing. Run
`bash bin/reload.sh` after editing the host; it refuses to restart on a syntax
error and runs the full test gate first.

## Development

```sh
bash bin/reload.sh      # check, test, restart the host (safe from inside a session)
node test/detect.test.mjs        # pane detection, against real captured panes
node test/agentstate.test.mjs    # the hook-vs-pane state machine
node test/install-hooks.test.mjs # settings.json merging
bash test/statusline.test.sh     # the status-line wrapper
bash test/hook-script.test.sh    # the hook script itself
bash test/e2e-hook.sh            # the whole chain, with a real Claude turn
```

`reload.sh` runs everything except the e2e test and refuses to restart if
anything fails.

**Detection is the fragile part.** Whether a session is "working" comes from
Claude Code's hooks first and pattern-matching the pane second. The patterns
live in `detect.mjs` with a comment on each explaining the false positive it
exists to prevent, and `test/fixtures/*.pane` are real captured panes with
their expected verdict recorded in `test/expected.json`. If you change a
pattern, capture the pane that motivated it and add it as a fixture — several
of those fixtures exist because a plausible-looking change broke something
subtle.

## Licence

MIT. See [LICENSE](LICENSE).
