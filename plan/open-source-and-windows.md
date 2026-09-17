# oneterm — open source, and Windows

Written 2026-09-09. Two separate questions that share one refactor.

---

## Part A — Open sourcing

The code is in better shape for this than expected. Every tracked source file was
grepped: **zero hardcoded usernames** in `server.mjs`, `detect.mjs`, `public/index.html`
or `bin/*`. Paths resolve from `$HOME`, tmux is discovered with fallbacks, the locale
has a default. One exception, listed below.

### What blocks it

| # | Blocker | Why it matters | Size |
|---|---|---|---|
| A1 | No `LICENSE` | Public without one = all rights reserved. Legally unusable by anyone. | 5 min |
| A2 | No `README.md` | macOS-only, needs tmux, node-pty needs the `spawn-helper` chmod. Nobody gets it running by guessing. | 1–2 h |
| A3 | Fixtures leak real work | 9 occurrences across 7 `.pane` files | 30 min |
| A4 | `package.json` | `"private": true`, no `license`/`description`/`repository`/`author` | 5 min |
| A5 | `test/collect-fixtures.py:8` | Hardcodes `~/Projects/oneterm` — the only path assumption in the repo | 5 min |

### A3 in detail — the only real privacy item

The fixtures are verbatim captures of live sessions. No credentials (scanned: no
`sk-`, `ghp_`, `AKIA`, connection strings, bearer tokens). But they contain:

```
/Users/dev/Projects/oneawaybuild | Fable 5.1 | ███████░░░ 71%
/Users/dev/Projects/oneaway-app  | Opus 5 (1M context) | ██████░░░░ 65%
⎿  $ cd /Users/dev/Projects/oneawaybuild; python3 - <<'PYEOF'
```

Home path, internal project names, and one line of actual client work.

**Fix:** a `sed` pass — `/Users/dev` → `/Users/you`, `oneawaybuild` →
`demo-build`, `oneaway-app` → `demo-app`. The detection patterns key on *position and
shape* on the status line, never on path content, so the suite is unweakened. Verify
24/24 still passes after the rewrite rather than assuming — the fixture whose status
line sits 4 rows from the bottom is the one to watch, since the substitution changes
line lengths and could reflow it.

**Licence recommendation:** MIT. Apache-2.0 if you want the explicit patent grant.
Not copyleft — it would discourage exactly the people most likely to adopt this.

---

## Part B — Windows

### The blocker is tmux, and only tmux

The entire stability model is *tmux owns the sessions, so the host is disposable*.
That single decision is what survives crashes, restarts and bad deploys. **tmux does
not run on native Windows** and never will — it is built on POSIX ptys and process
groups.

Everything else already ports. Measured, not assumed:

- **node-pty ships `win32-x64` and `win32-arm64` prebuilds today.** ConPTY works out
  of the box; no native build step for users.
- `detect.mjs` is pure string matching over terminal text. Platform-independent as
  written, and already isolated behind `classify()`.
- The client (`public/index.html`) is a browser page. Nothing platform-specific.
- Sounds, favicon badges, notifications: all browser-side.
- The security model (bind `127.0.0.1`, Host + Origin allowlist, POST-only mutations)
  is identical on Windows.

### How deep the tmux coupling actually goes

**20 call sites, 7 distinct subcommands** — and the shape is favourable:

```
11 × set-option       →  session metadata (label, cwd, cmd, skip, order)
 3 × list-sessions    →  the session registry
 2 × set-environment  →  locale stamping
 1 × new-session      →  create detached
 1 × kill-session     →  destroy
 1 × capture-pane     →  the screen, for state detection
 1 × pty.spawn(attach)→  attach a viewer
```

Eleven of the twenty are **metadata**, which on any other backend is a JSON file.
The genuinely tmux-shaped requirements are only three:

1. **Detached persistence** — a session outlives the process that created it
2. **Attach / detach** — many viewers, none of them owning the session
3. **Screen capture** — "what does this pane look like right now", for the rail state

### Two paths

#### Path 1 — WSL (small)

tmux runs normally. oneterm runs unchanged inside WSL2; the browser on Windows reaches
it because WSL2 forwards `localhost`. Work is install and documentation, not code:

- `bin/install.sh` gains a Linux branch — a systemd **user** unit (`systemctl --user`,
  `Restart=always`) in place of the launchd plist
- Document the `localhost:7331` forwarding and that Chrome runs on the Windows side
- `bin/chaos.sh` and `bin/reload.sh` each contain exactly one `launchctl` line to
  branch on

**Estimate: 1 day.** Low risk, no architectural change. The chaos suite should pass
unmodified once the restart mechanism is abstracted.

#### Path 2 — native Windows (the real work)

Requires replacing tmux with a **session daemon**: a small long-lived process that owns
the ptys and outlives the web host, preserving the disposability property rather than
abandoning it.

```
Browser ─WS─> host (disposable) ─IPC─> session daemon (persistent) ─ConPTY─> claude / pwsh
```

- **Persistence** — the daemon holds node-pty ConPTY processes. Host restarts freely.
- **Attach/detach** — viewers connect to the host, host relays to the daemon. Multiple
  viewers mirror, exactly as `attach-session` without `-d` does now.
- **Screen capture** — this is the neat part. Keep an `@xterm/headless` Terminal per
  session inside the daemon, feed it the pty output, and read its buffer. That is a
  *better* `capture-pane`: same emulator the browser already runs, so what detection
  sees and what you see cannot diverge.
- **Metadata** — a JSON file replaces the eleven `set-option` calls.

**The prerequisite refactor, and it is worth doing regardless:** extract a
`SessionBackend` interface — `list()`, `create()`, `kill()`, `setMeta()`, `capture()`,
`attach()` — with `TmuxBackend` as the first implementation. Pure refactor, no
behaviour change, and it is already covered: `chaos.sh` (10 assertions) proves session
survival, `detect.test.mjs` (24) proves detection is untouched. That is unusually good
cover for a refactor of this kind and it exists by accident of this week's work.

**Estimate:**

| Piece | Size | Risk |
|---|---|---|
| `SessionBackend` abstraction + `TmuxBackend` | 1–2 days | Low — tests cover it |
| `DaemonBackend` + daemon process | 4–6 days | **High** — crash recovery, IPC, lifecycle |
| Windows installer (`install.ps1`, Startup/Task Scheduler, `.lnk`) | 1–2 days | Medium |
| Shell defaults (`pwsh` vs `zsh -l -c`), path handling | 1 day | Low |
| Windows-specific testing | 2–3 days | Medium — needs a real Windows box |

**Total: 9–14 days.** The daemon dominates, and its risk is not writing it — it is
matching tmux's *reliability*, which is thirty years old and has survived everything.
A new daemon has not. Expect the first version to lose a session in a way tmux never
would, and budget for that rather than being surprised by it.

### Recommendation

**Ship WSL first**, and say so plainly in the README rather than implying full Windows
support. It is one day of work, it covers most developers running Claude Code on
Windows today, and it does not touch the architecture.

Then do the `SessionBackend` refactor **whether or not native Windows ever happens** —
it isolates the one genuinely non-portable dependency behind an interface, and it makes
the tmux assumption visible instead of scattered across twenty call sites.

Native Windows becomes a decision you can make later with information, rather than a
rewrite you are locked out of. If it goes ahead, `DaemonBackend` also becomes the
answer for anyone who wants oneterm without installing tmux at all — which may
ultimately matter more than Windows does.

### One caveat worth stating

The reason to run oneterm is Claude Code. Claude Code runs on native Windows, but a
great deal of real work through it is unix-shell-shaped — `grep`, `sed`, heredocs, the
`bin/*.sh` scripts in this very repo. A native-Windows oneterm gives a working terminal
in a browser tab; it does not make a Windows box behave like a mac. For most people
asking for Windows support, **WSL is not the compromise — it is the correct answer**,
and the native path is for the narrower case of someone who genuinely cannot use WSL.

---

## Suggested order

1. **A1–A5** — open source hygiene, half a day, unblocks everything
2. **WSL support** — 1 day, real reach for little risk
3. **`SessionBackend` refactor** — 1–2 days, valuable on its own merits
4. **Native Windows** — 9–14 days, only if demand is real
