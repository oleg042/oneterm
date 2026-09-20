/**
 * oneterm — your terminal, in the browser, in one window.
 *
 *   Browser (xterm.js) <--WebSocket--> this host <--PTY--> tmux <-- claude / zsh
 *
 * THE STABILITY DECISION: this host owns nothing.
 *
 * Every session is a tmux session. The host only attaches a PTY to tmux and
 * pumps bytes. So the host can crash, be OOM-killed, be restarted by launchd,
 * or be replaced by a new version mid-session — and your work is untouched,
 * because tmux is still holding it. Reattach and tmux repaints.
 *
 * That also makes tmux the single source of truth for "what sessions exist".
 * There is no in-memory session table to drift, and no localStorage list that
 * can disagree with reality. `tmux ls` IS the list.
 */
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir, access, realpath, stat, rename, readdir, open } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, basename } from 'node:path'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { WebSocketServer } from 'ws'
import pty from 'node-pty'
// Detection lives in its own module so test/detect.test.mjs runs the patterns
// that actually ship, against panes captured from live sessions.
import { classify, liveTail, LIVE_LINES, paneWindow } from './detect.mjs'
// Same reason as detect.mjs: the tests must run the decision that ships, not a
// copy of it. This one has been wrong twice, so it is the last place to allow
// a second implementation to drift.
import { hookWorking as agentsWorking, applyEvent, decideWorking } from './agentstate.mjs'

const execFileP = promisify(execFile)
const ROOT = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 7331)
const PREFIX = 'oneterm_'

/* launchd gives us a bare PATH, so never rely on it — resolve real paths once. */
const TMUX = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux']
  .find(p => existsSync(p)) ?? 'tmux'
const SHELL = process.env.SHELL || '/bin/zsh'
/* One locale, used for the session, the attach client and the tmux server, so
 * they cannot disagree. launchd supplies no LANG, so the fallback is real. */
const LOCALE = process.env.LC_ALL || process.env.LANG || 'en_US.UTF-8'

/** Run a command through a LOGIN shell so the user's real PATH applies. */
const loginShell = (cmd) => [SHELL, '-l', '-c', cmd]

async function tmux(args) {
  try { return (await execFileP(TMUX, args)).stdout } catch (e) { return e.stdout ?? '' }
}

/* ── session registry: tmux is the database ───────────────────────────────── */

/** Metadata rides along as tmux user-options (@oneterm_*), so it survives us. */
async function listSessions() {
  // NOT tab-separated: tmux's format parser eats literal tabs, which silently
  // collapsed every field into the session id and made every attach fail with
  // "session is gone". Any non-whitespace delimiter works; this one won't
  // appear in a label or a path.
  const D = '|~|'
  const fmt = ['#{session_name}', '#{session_created}', '#{session_attached}',
               '#{@oneterm_label}', '#{@oneterm_cwd}', '#{@oneterm_cmd}',
               '#{@oneterm_skip}', '#{@oneterm_order}',
               '#{pane_current_path}'].join(D)
  const out = await tmux(['list-sessions', '-F', fmt])
  const FIELDS = 9
  return out.split('\n').filter(l => l.startsWith(PREFIX)).map(line => {
    const parts = line.split(D)
    // A row with the wrong field count means something injected the delimiter.
    // Drop it rather than render shifted fields as if they were real.
    if (parts.length !== FIELDS) { console.warn('[skip malformed row]', parts[0]); return null }
    const [name, created, attached, label, cwd, cmd, skip, order, livePath] = parts
    return { id: name.slice(PREFIX.length), name,
             created: Number(created) * 1000, attached: attached !== '0',
             label: label || name, cmd: cmd || 'shell',
             skip: skip === '1',
             order: order === '' || order === undefined ? null : Number(order),
             // THE path. A login shell can cd away from tmux's -c, so the
             // requested cwd is a wish and pane_current_path is the fact.
             // Showing the wish is how `rm -rf build/` hits the wrong tree.
             cwd: livePath || cwd || '' }
  }).filter(Boolean).sort((a, b) => {
    // explicit drag order first; anything never dragged falls back to age
    const ao = a.order, bo = b.order
    if (ao !== null && bo !== null) return ao - bo
    if (ao !== null) return -1
    if (bo !== null) return 1
    return a.created - b.created
  })
}


/* A multi-session cockpit has to distinguish "working" from "blocked on YOU".
 * tmux can hand us the tail of each pane cheaply, so detect the shapes Claude
 * Code actually uses when it is waiting on a human decision. Without this a
 * blocked agent and an idle shell look identical, which defeats the point of
 * running four at once. */
async function paneTail(name) {
  /* The VISIBLE pane only — no -S, so no scrollback. Both signals we look for
   * describe the current frame: a run marker that is on screen now, or a prompt
   * awaiting an answer now. Reading history meant a marker from an old, long
   * finished turn kept a session pinned to "working". */
  const out = await tmux(['capture-pane', '-p', '-t', name])
  /* Keep LINES, not bytes.
   *
   * This used to be .slice(-2000), which is about 25 lines at 80 columns but
   * only ten at 191 — so on a wide pane the window silently shrank below
   * LIVE_LINES and the detector never saw the bottom of the screen it was
   * supposed to be reading. A session ran visibly for six minutes showing an
   * idle dot because its spinner sat 2,506 characters from the end.
   *
   * It defeated the hook too, which is why it took so long to spot: the hook
   * correctly reported working=true, the truncated pane disagreed for longer
   * than MISSED_STOP_MS, and the missed-Stop fallback concluded the hook was
   * the stale one. One cap, both layers.
   *
   * The byte ceiling stays as a bound on pathological widths, but it is now
   * far enough above any real terminal that it cannot trim a line count. */
  return paneWindow(out)
}
/* A run is detected by sampling an ANIMATING pane, so a single miss is a
 * blink, not an ending. Keep "working" latched for a few seconds after the last
 * positive match: the state stops flickering, the rail dot stops stuttering,
 * and — the point — the transition to "not working" happens exactly once, when
 * the agent has really stopped. */
/* Latches, per session KIND — they were not equal before and that asymmetry
 * was half the false chimes.
 *   claude: watches for positive run markers, and those genuinely vanish for a
 *           while when a turn hands off to sub-agents. At 5s that read as an
 *           ending and chimed mid-run, repeatedly, on a run that never stopped.
 *   shell:  had NO latch at all — one poll where the pane happened to be
 *           byte-identical dropped it straight to "not working". */
const LATCH_CLAUDE = 12000
const LATCH_SHELL  = 6000
const workingUntil = new Map()
const lastTail = new Map()
/* Attaching or resizing a pane makes tmux REFLOW its contents, which changes
 * the captured text without a single byte of new output. The tail-diff can't
 * tell that apart from real work, so a session flashed "working" the moment you
 * clicked it. Suppress the signal briefly and re-baseline instead. */
const settleUntil = new Map()
function settle(name, ms = 1800) {
  settleUntil.set(name, Date.now() + ms)
  lastTail.delete(name)          // next capture becomes the new baseline
  workingUntil.delete(name)      // and drop a latch a reflow would have set
}

/**
 * The PANE half of the answer: is this session working according to its screen,
 * with the latch applied. Arms the latch as a side effect; returns the verdict.
 *
 * The latch is what makes a sampled signal usable — a single missed frame of an
 * animating pane is a blink, not an ending, and every blink used to read as
 * "the run finished" and ring the bell.
 */
function panePulse(s, tail, c) {
  const now = Date.now()
  const latchMs = s.cmd === 'claude' ? LATCH_CLAUDE : LATCH_SHELL
  if (s.cmd === 'claude') {
    if (c.working) workingUntil.set(s.name, now + latchMs)
  } else {
    /* Shells print no run marker, so fall back to "the pane changed since last
     * poll". tmux's #{session_activity} was tried first and rejected: it does
     * not reliably tick for a DETACHED session, so a busy agent read as idle.
     * Comparing the tail works either way. */
    const settling = now < (settleUntil.get(s.name) ?? 0)
    const prev = lastTail.get(s.name)
    lastTail.set(s.name, tail)
    if (!settling && prev !== undefined && prev !== tail)
      workingUntil.set(s.name, now + latchMs)
  }
  return { latchMs, working: now < (workingUntil.get(s.name) ?? 0) }
}

/* ── agent state, reported by Claude Code itself ──────────────────────────
 * Everything below this used to be inferred by matching regexes against the
 * pane. That is now the FALLBACK. Claude Code publishes lifecycle events, and
 * hooks/oneterm-agent-state.sh reports them here, so a turn boundary is a fact
 * rather than a guess about a spinner.
 *
 * PERSISTED, and that is not incidental: this host is designed to be
 * disposable, and it restarts constantly. In-memory state would be lost on
 * every restart and every session would silently drop back to regex — the
 * exact failure this replaces, just rarer and therefore harder to notice. */
// process.env.HOME, not the HOME const — that is declared further down the
// file and this line runs at module load, so referencing it would be a
// temporal dead zone ReferenceError at boot. node --check does not catch it.
const HOOK_FILE = join(process.env.HOME, '.oneterm', 'agent-state.json')
/* Keyed by OUR session id, but each entry holds a map of CLAUDE session ids,
 * because ONETERM_SESSION is stamped on the tmux session and is therefore
 * inherited by every pane, window and subprocess inside it. Two `claude`
 * processes in one tmux session — a second window, or a nested invocation from
 * a script — would otherwise share one boolean, and whichever finished last
 * would declare the other one idle while it was still running. Working means
 * ANY agent in the session is working. */
const hookState = new Map()      // our id -> { agents: {claudeSession: {working, at}}, at, transcript }
const hookWorking = id => agentsWorking(hookState.get(id), Date.now())
const hookQuiet = new Map()      // name -> first time the pane contradicted the hook

async function loadHookState() {
  try {
    const raw = JSON.parse(await readFile(HOOK_FILE, 'utf8'))
    let cleaned = false
    for (const [id, v] of Object.entries(raw)) {
      // Migrate the first shape, which held one boolean per session before
      // concurrent agents in a single tmux session were accounted for.
      if (v && !v.agents) { cleaned = true; hookState.set(id, { at: v.at, transcript: v.transcript,
                                              agents: { _: { working: v.working, at: v.at } } }) }
      else {
        /* Retire the anonymous bucket at LOAD as well as on the next event.
           It only exists for migrated state or a machine without python3, and
           alongside a real Claude id it can only be stale — a stale bucket
           stuck on working=true pins the whole session busy, because working
           is ANY agent. Waiting for the next event to clean it up leaves that
           lie in place for however long the session stays quiet. */
        if (v?.agents?._ && Object.keys(v.agents).length > 1) { delete v.agents._; cleaned = true }
        hookState.set(id, v)
      }
    }
    // Migration and retirement above only touched MEMORY. Write once so the
    // file matches, or every boot repeats the same cleanup on the same rows.
    if (cleaned) saveHookState()
    console.log(`[hook] restored ${hookState.size} session(s)${cleaned ? ', cleaned legacy buckets' : ''}`)
  } catch { /* first run, or unreadable — regex fallback covers it */ }
}
let saveTimer = null
function saveHookState() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(async () => {
    try {
      await mkdir(dirname(HOOK_FILE), { recursive: true })
      /* Temp file + rename, the same as the settings installer. A plain write
         truncated by a crash leaves invalid JSON, and loadHookState would then
         discard EVERY session's state on the next boot — defeating the
         persistence at precisely the moment it exists to survive. This host is
         built to be killed, so that is not a hypothetical. */
      const tmp = HOOK_FILE + '.tmp'
      await writeFile(tmp, JSON.stringify(Object.fromEntries(hookState)))
      await rename(tmp, HOOK_FILE)
    } catch {}
  }, 250)
}
/* start -> a turn began · stop -> it ended · session -> just the id linkage.
 * SubagentStop never reaches here: the hook drops anything carrying agent_id. */
function applyAgentEvent({ id, action, claudeSession, transcript, model, ctxPct, ctxSize, limits }) {
  if (!id) return false
  const entry = applyEvent(hookState.get(id),
                           { action, claudeSession, transcript, model, ctxPct, ctxSize, limits })
  hookState.set(id, entry)

  /* A status report is not a turn boundary and must not be treated as one.
     Clearing hookQuiet here would be a real bug rather than a cosmetic one:
     that timestamp is how decideWorking eventually gives up on a Stop that
     was lost while the host was restarting, and the status line re-renders
     often enough to reset it forever — pinning the session working for good.
     It is also far too frequent to log. */
  if (action === 'status') { saveHookState(); return true }

  /* A stop CLEARS the latch. That is what the event buys us: the pane's own
     verdict becomes authoritative immediately instead of 12 seconds later.
     If a turn is genuinely still running the next poll re-arms it. */
  if (action === 'stop' && hookWorking(id) === false) workingUntil.delete(PREFIX + id)
  hookQuiet.delete(PREFIX + id)
  saveHookState()
  const w = hookWorking(id)
  console.log(`[hook] ${id} ${action}`
    + (w === undefined ? '' : ` working=${w ? 1 : 0}`)
    + (Object.keys(entry.agents).length > 1 ? ` (${Object.keys(entry.agents).length} agents)` : ''))
  return true
}

/* There were NO logs, so a false chime could only be argued about, never
 * diagnosed. The sound fires client-side off these two booleans, so record
 * every flip together with the evidence that caused it: which pattern matched,
 * and what the bottom of the pane actually said. Transitions only — logging
 * every poll would bury the one line that matters. */
/* The newest rate-limit reading any session has reported.
 *
 * These windows are the ACCOUNT's, not a session's, but they only arrive when
 * some session re-renders its status line — so every session holds a snapshot
 * from a different moment. Showing each session its own made the weekly number
 * change as you switched tabs, which reads as a bug because it is one: the
 * quota did not move, the observation time did. Newest wins, for everyone.
 *
 * With two accounts in play this shows whichever reported last rather than
 * per-account values. That is a real limitation and a deliberate trade: the
 * flicker was certain and observed, the second account is hypothetical. */
function freshestLimits() {
  /* Merged PER WINDOW, not per report. Claude Code omits a window entirely
     when it has just rolled over — three sessions here reported seven_day
     alone right after the 5-hour reset — so taking one session's object
     wholesale made the 5h meter vanish for every tab the moment one of those
     reports happened to be the newest. A report that is silent about a window
     is not evidence that the window is gone. */
  const out = {}
  const at = {}
  for (const v of hookState.values()) {
    const seen = v?.limitsAt ?? 0
    for (const [k, w] of Object.entries(v?.limits ?? {})) {
      if (seen >= (at[k] ?? -1)) { out[k] = w; at[k] = seen }
    }
  }
  /* A window whose reset time has passed is obsolete by definition: the window
     rolled over and this number describes the previous one. Drop it rather
     than show a stale bar, and let the next report re-establish it. */
  const now = Date.now()
  for (const [k, w] of Object.entries(out)) {
    if (w?.resets && w.resets * 1000 < now) delete out[k]
  }
  return Object.keys(out).length ? out : undefined
}

const prevState = new Map()
function logState(s, why, tail) {
  const p = prevState.get(s.name)
  prevState.set(s.name, { working: s.working, waiting: s.waiting })
  if (!p) return                                   // first sight is not a flip
  if (p.working === s.working && p.waiting === s.waiting) return
  console.log(`[state] ${s.name} ${s.cmd}`
    + ` work ${p.working ? 1 : 0}->${s.working ? 1 : 0}`
    + ` wait ${p.waiting ? 1 : 0}->${s.waiting ? 1 : 0}`
    + ` via ${why} | ${JSON.stringify(liveTail(tail, 3).slice(-180))}`)
}
let sessionCache = { at: 0, data: null }
async function sessionsCached() {
  // /sessions costs one spawn per session (capture-pane). A short cache keeps a
  // second tab, or a double render, from multiplying that.
  if (Date.now() - sessionCache.at < 700 && sessionCache.data) return sessionCache.data
  const data = await annotateWaiting(await listSessions())
  sessionCache = { at: Date.now(), data }
  return data
}

async function annotateWaiting(list) {
  await Promise.all(list.map(async (s) => {
    try {
      const tail = await paneTail(s.name)
      const c    = classify(tail, s.cmd)          // pure, shared with the tests
      const pane = panePulse(s, tail, c)          // pane + latch bookkeeping

      // The rule this implements lives in agentstate.mjs, next to the code.
      const d = decideWorking({
        hook: hookWorking(s.id),
        paneWorking: c.working,
        regexWorking: pane.working,
        quietSince: hookQuiet.get(s.name) ?? null,
      })

      s.working   = d.working
      s.waiting   = c.waiting
      s.latchMs   = d.latched ? pane.latchMs : 0  // an event needs no blink tolerance
      s.stateFrom = d.from                        // the ACTUAL decider

      /* Reported by the status line, not inferred here. Undefined until the
         first render arrives — the rail draws nothing rather than a zero,
         because "0%" and "don't know yet" are different things. */
      const hs = hookState.get(s.id)
      s.ctxPct = hs?.ctxPct
      s.model  = hs?.model
      /* NOT hs.limits. These windows belong to the ACCOUNT, not the session,
         and a session only reports them when it happens to re-render — so
         per-session values are just snapshots from different moments, and the
         weekly number visibly changed as you switched tabs. Every session gets
         the newest reading anyone has. */
      s.limits = freshestLimits()

      if (d.quietSince === null) hookQuiet.delete(s.name)
      else hookQuiet.set(s.name, d.quietSince)

      // Actively PRINTING is never "needs you" (classify already applied that
      // for the claude path). Background work is not printing, so it does not
      // hide a prompt: a shell can run behind a question that is blocked on you.
      if (s.working && s.cmd !== 'claude') s.waiting = false

      logState(s, d.why ?? (s.cmd === 'claude' ? c.why : 'tail-diff'), tail)
    } catch (e) {
      /* Log this path too. The client still receives working=false here and can
         chime on it, and without a line the one stray sound nobody can explain
         is the one with no evidence. It also keeps prevState honest: skipping
         it left the previous value in place, so the next real transition was
         logged with the wrong "from". */
      s.waiting = false; s.working = false
      logState(s, 'capture failed: ' + (e?.message ?? e), '')
    }
  }))
  // These are keyed by session name and would otherwise grow forever in a
  // process designed to run for weeks.
  const live = new Set(list.map(s => s.name))
  for (const k of lastTail.keys())     if (!live.has(k)) lastTail.delete(k)
  for (const k of settleUntil.keys())  if (!live.has(k)) settleUntil.delete(k)
  for (const k of workingUntil.keys()) if (!live.has(k)) workingUntil.delete(k)
  for (const k of prevState.keys())    if (!live.has(k)) prevState.delete(k)
  for (const k of hookQuiet.keys())    if (!live.has(k)) hookQuiet.delete(k)
  // hookState is keyed by our session id, not the tmux name, and it is the one
  // map that outlives the process — so pruning it is what stops the on-disk
  // file growing for the life of the machine.
  const liveIds = new Set(list.map(s => s.id))
  let pruned = false
  for (const k of hookState.keys()) if (!liveIds.has(k)) { hookState.delete(k); pruned = true }
  if (pruned) saveHookState()
  return list
}

/* ── past conversations, across every folder ──────────────────────────────
 * Claude Code keeps one JSONL per conversation under ~/.claude/projects/<dir>.
 * Its own /resume picker is scoped to the folder you launched in, so resuming
 * something from another project means knowing which folder it was and going
 * there first. Everything needed to skip that is already in the file.
 *
 * The cwd is read FROM THE TRANSCRIPT, never decoded from the directory name:
 * that name is the path with slashes turned into dashes, and a folder whose
 * own name contains a dash — skanai-dispatch — is then impossible to decode
 * unambiguously. The file states its cwd; use it. */
const CLAUDE_PROJECTS = join(process.env.HOME, '.claude', 'projects')
const CONV_LIMIT = 80          // a picker, not an archive
const CONV_HEAD  = 64 * 1024   // metadata lives in the first few lines
/* …but RECENCY lives at the other end, and not in the file's mtime.
 *
 * Sorting by mtime looked right for months and is wrong: Claude Code appends
 * its own housekeeping — bridge-session, system — to many transcripts at once,
 * so fourteen conversations were stamped within the same 2.5 seconds and every
 * one of them read "29m" in the picker, including ones untouched for days.
 * mtime answers "when did Claude Code last write to this file", which is a
 * different question from "when did you last talk in here".
 *
 * Generous, because a single attachment record can be enormous and the tail
 * has to contain at least one complete message line to be any use. */
const CONV_TAIL  = 256 * 1024
let convCache = { at: 0, data: null }

/** Pull {id, cwd, title, at} out of one transcript without reading all of it. */
async function readConversation(path, mtime) {
  let fh
  try {
    fh = await open(path, 'r')
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(CONV_HEAD), 0, CONV_HEAD, 0)
    const head = buffer.subarray(0, bytesRead).toString('utf8')
    let cwd = null, title = null, id = null, firstUser = null
    // The last line of a bounded read is usually truncated — drop it.
    const lines = head.split('\n'); lines.pop()
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
    if (!id || !cwd) return null          // cannot resume what we cannot place

    /* When did this conversation last say anything? Read the END of the file
       and take the newest user/assistant record's own timestamp. Only those
       two types count: everything else in here is bookkeeping that Claude Code
       writes on its own schedule, which is exactly what made every row show
       the same age. Falls back to mtime when the tail holds no complete
       message — wrong in the old way, rather than missing. */
    const size = (await fh.stat()).size
    const tailStart = Math.max(0, size - CONV_TAIL)
    let at = mtime
    if (size > 0) {
      const t = await fh.read(Buffer.alloc(Math.min(CONV_TAIL, size)), 0,
                              Math.min(CONV_TAIL, size), tailStart)
      const tailLines = t.buffer.subarray(0, t.bytesRead).toString('utf8').split('\n')
      if (tailStart > 0) tailLines.shift()     // first line of a mid-file read is a fragment
      for (let i = tailLines.length - 1; i >= 0; i--) {
        let d; try { d = JSON.parse(tailLines[i]) } catch { continue }
        if (d.type !== 'user' && d.type !== 'assistant') continue
        const ts = Date.parse(d.timestamp ?? '')
        if (Number.isFinite(ts)) { at = ts; break }
      }
    }
    return { id, cwd, title: title || firstUser || basename(cwd), preview: firstUser || '', at }
  } catch { return null }
  finally { await fh?.close().catch(() => {}) }
}

async function readConversations() {
  if (Date.now() - convCache.at < 15_000 && convCache.data) return convCache.data
  const found = []
  try {
    for (const dir of await readdir(CLAUDE_PROJECTS)) {
      const full = join(CLAUDE_PROJECTS, dir)
      let names; try { names = await readdir(full) } catch { continue }
      for (const n of names) {
        if (!n.endsWith('.jsonl')) continue
        try { found.push({ path: join(full, n), mtime: (await stat(join(full, n))).mtimeMs }) } catch {}
      }
    }
  } catch { /* no ~/.claude/projects — nothing to resume */ }
  // Newest first, and only open the ones a picker will actually show: reading
  // the head of 119 files on every keystroke is not free.
  found.sort((a, b) => b.mtime - a.mtime)
  const data = (await Promise.all(
    found.slice(0, CONV_LIMIT).map(f => readConversation(f.path, f.mtime))
  )).filter(Boolean)
  /* Re-sort on the REAL timestamp. The slice above is ordered by mtime, which
     is a fine cheap filter for "which files are worth opening" but not for the
     order they are shown in — mtime moves when Claude Code writes housekeeping,
     so the newest file is not reliably the newest conversation. */
  data.sort((a, b) => b.at - a.at)
  convCache = { at: Date.now(), data }
  return data
}

async function createSession({ id, cmd, cwd, cols, rows, skip, resume }) {
  const name = PREFIX + id
  /* A resumed conversation is still a claude session; it just starts with
     --resume <id>. The id comes from the transcript's own sessionId, and the
     session is created with that conversation's cwd, so the agent wakes up
     where it left off rather than wherever the picker was opened from. */
  const claudeCmd = 'claude'
    + (skip ? ' --dangerously-skip-permissions' : '')
    + (resume ? ` --resume ${resume}` : '')
  /* A claude session must OUTLIVE claude.
   *
   * This used to be bare `claude`, which made the agent the tmux session's
   * only command — so the moment it exited, tmux had nothing left to run and
   * ended the session. The tab vanished from the rail with no click, no
   * confirmation and no /kill in the log, and the conversation could only be
   * recovered through the resume picker. Claude Code exits on its own for
   * ordinary reasons: "Restart to update" after an auto-update (ten sessions
   * here were spread across six different versions), /quit, ctrl-D, a crash.
   *
   * Falling through to a login shell keeps the tmux session, the id, the
   * label, the scrollback and the tab. The echo is there because an empty
   * shell prompt where an agent used to be is its own small mystery. */
  /* …and when it falls through, the session RE-LABELS ITSELF as a shell.
   *
   * @oneterm_cmd is what the rail reads for the CC/SH tag and what the
   * detector keys its patterns off, so leaving it on "claude" after the agent
   * is gone means a shell being matched against spinner patterns and wearing a
   * CC badge. The session is the only thing that knows the moment claude
   * returned, so it reports that itself rather than the host guessing from the
   * outside — pane_current_command cannot tell, since the wrapper shell is the
   * pane's process either way.
   *
   * @oneterm_label is deliberately NOT touched: the tab keeps its name. */
  const inner = cmd === 'claude'
    ? `${claudeCmd}; ${TMUX} set-option -t ${name} @oneterm_cmd shell 2>/dev/null; ` +
      `echo; echo "[oneterm] claude exited — this tab is now a shell. ` +
      `run 'claude --continue' to pick up where you left off."; exec ${SHELL} -l`
    : `exec ${SHELL} -l`
  // -d: create detached, so creation never depends on a client being ready.
  // -e: the inner shell inherits the HOST's environment, not the attach
  //     client's — so ONETERM_* set at attach time never reached the shell.
  //     Stamp them at birth so scripts and hooks inside can tell where they are.
  /* The locale has to be stamped HERE, on the session itself.
   *
   * It was already set on the attach client (see the pty env below) and on the
   * host via the plist — which is why the DISPLAY always looked right and this
   * hid for so long. But a tmux session inherits from the tmux SERVER, not from
   * whoever asks for the session, and that server's environment has no LANG at
   * all. So every shell and every Claude Code inside oneterm has been running
   * under LC_CTYPE="C".
   *
   * Measured symptom: paste a table into Claude Code and "│" (UTF-8 e2 94 82)
   * comes back as "‚îÇ" — those same three bytes read one-at-a-time and
   * re-encoded, which is exactly what a C locale does to multibyte input. The
   * bytes on the wire were provably fine; the decoder at the far end was not.
   * zsh in the same session also refuses printf '│' with "character not
   * in range". */
  await tmux(['-u', 'new-session', '-d', '-s', name, '-c', cwd,
              '-e', `LANG=${LOCALE}`, '-e', `LC_ALL=${LOCALE}`,
              /* ONETERM_SESSION is what gates the agent-state hook: it is
                 registered globally in ~/.claude/settings.json and runs for
                 every Claude Code on the machine, so it exits immediately
                 unless it finds this. ONETERM_PORT tells it where to report,
                 so a non-default PORT still works. */
              '-e', 'ONETERM=1', '-e', `ONETERM_SESSION=${id}`,
              '-e', `ONETERM_PORT=${PORT}`,
              '-x', String(cols || 120), '-y', String(rows || 32),
              ...loginShell(inner)])
  const label = cwd.split('/').filter(Boolean).pop() || '~'
  await tmux(['set-option', '-t', name, '@oneterm_label', label])
  await tmux(['set-option', '-t', name, '@oneterm_cwd', cwd])
  await tmux(['set-option', '-t', name, '@oneterm_cmd', cmd])
  // shells have no such flag — never stamp a session with a badge that lies
  await tmux(['set-option', '-t', name, '@oneterm_skip',
              (skip && cmd === 'claude') ? '1' : '0'])
  /* A new session belongs at the TOP of the rail.
   *
   * This used to be Date.now() % 100000 — a five-digit number sitting next to
   * the 0, 10, 20… that dragging assigns, so every session you started landed
   * underneath everything you started days ago, which is the opposite of where
   * you are about to look. Place it above the current minimum instead.
   *
   * Only oneterm's own sessions count: `list-sessions` also returns whatever
   * else lives on this tmux server, and those report an EMPTY @oneterm_order,
   * which Number() reads as 0 and would drag the minimum to zero. */
  const orders = (await tmux(['list-sessions', '-F', `#{session_name}|~|#{@oneterm_order}`]))
    .split('\n')
    .filter(l => l.startsWith(PREFIX))
    .map(l => l.split('|~|')[1])
    .filter(v => v !== undefined && v !== '')
    .map(Number)
    .filter(Number.isFinite)
  const topOrder = orders.length ? Math.min(...orders) - 10 : 0
  await tmux(['set-option', '-t', name, '@oneterm_order', String(topOrder)])
  // Let the pane use the full client size rather than the smallest ever attached.
  await tmux(['set-option', '-t', name, 'window-size', 'latest'])
  await tmux(['set-option', '-t', name, 'status', 'off'])   // no tmux bar; our UI is the chrome
  await tmux(['set-option', '-t', name, 'mouse', 'on'])
  await tmux(['set-option', '-t', name, 'history-limit', '50000'])
  // tmux() swallows failures, so without this /new could hand back an id for a
  // session that was never created and the client would attach to nothing.
  const live = await tmux(['list-sessions', '-F', '#{session_name}'])
  if (!live.split('\n').includes(name))
    throw new Error(`tmux refused to create the session (cwd: ${cwd})`)
  return name
}

/* ── skills + projects: what the ⌘K palette searches ──────────────────────── */

const HOME = process.env.HOME
const DROPS = join(HOME, '.oneterm', 'drops')
const MAX_DROP = 64 * 1024 * 1024
const exists = (f) => access(f).then(() => true).catch(() => false)
async function readSkills() {
  // ~/.claude/skills/<name>/SKILL.md, plugin skills, and project-local ones.
  const roots = [join(HOME, '.claude/skills'), join(HOME, '.claude/plugins')]
  const out = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    const found = await tmuxlessFind(root, 'SKILL.md')
    for (const f of found) {
      try {
        const txt = await readFile(f, 'utf8')
        const meta = parseFrontmatter(txt)
        if (meta.name) out.push({ name: meta.name, desc: meta.description || '', path: f })
      } catch {}
    }
  }
  // ...and commands/*.md, which is where /commit, /code-review etc. actually
  // live. Indexing only SKILL.md hid the most-typed slash commands entirely.
  for (const root of [join(HOME, '.claude/commands'), join(HOME, '.claude/plugins')]) {
    if (!existsSync(root)) continue
    for (const f of await findMd(root)) {
      if (!/\/commands\//.test(f)) continue
      try {
        const txt = await readFile(f, 'utf8')
        const meta = parseFrontmatter(txt)
        const name = f.split('/').pop().replace(/\.md$/, '')
        const desc = meta.description
          || txt.replace(/^---[\s\S]*?---/, '').trim().split('\n')[0].replace(/^#+\s*/, '')
        out.push({ name, desc: (desc || '').slice(0, 160), path: f, kind: 'command' })
      } catch {}
    }
  }
  /* Project-level skills live in <project>/.claude/skills. Claude Code only
   * offers them while you are IN that project, so they are tagged with their
   * project and the client shows them only for a session whose cwd is inside
   * it — listing them globally would advertise skills that will not fire. */
  const projRoot = join(HOME, 'Projects')
  for (const f of await findUnder(projRoot, 'SKILL.md', 6)) {
    if (!/\/\.claude\/skills\//.test(f)) continue
    const project = f.slice(projRoot.length + 1).split('/')[0]
    if (project.startsWith('.')) continue
    try {
      const meta = parseFrontmatter(await readFile(f, 'utf8'))
      if (meta.name) out.push({ name: meta.name, desc: meta.description || '', path: f,
                                scope: 'project', project,
                                dir: join(projRoot, project) })
    } catch {}
  }

  /* Identity is not the name, and it is not the path either — it is
   * (scope, name) resolved to the BEST copy of that file.
   *
   * Two different files can share a name: a project /push shadows a global
   * /push, and both must survive so the viewer can tell them apart.
   * One file can appear under many paths: symlinked into ~/.claude/skills, and
   * cached by the plugin manager once per version — the cache holds seven
   * copies of /commit. Those are not seven skills.
   *
   * So: collapse symlinks by real path, then keep one per (scope, name),
   * preferring what the user actually owns over a marketplace copy over a
   * version cache. A symlinked global therefore outranks its project original,
   * which is the point of symlinking it in. */
  const rank = (f) =>
      f.startsWith(join(HOME, '.claude/skills')) || f.startsWith(join(HOME, '.claude/commands')) ? 0
    : f.includes('/plugins/marketplaces/') ? 1
    : f.includes('/plugins/cache/') ? 3
    : 2

  const byReal = new Map()
  for (const k of out) {
    const real = await realpath(k.path).catch(() => k.path)
    if (!byReal.has(real)) byReal.set(real, { ...k, real })
  }
  const best = new Map()
  for (const k of byReal.values()) {
    const key = (k.scope || 'global') + ':' + k.name
    const prev = best.get(key)
    if (!prev || rank(k.path) < rank(prev.path)) best.set(key, k)
  }
  const list = [...best.values()]
  for (const k of list) { readable.add(k.path); readable.add(k.real) }
  return list.sort((a, b) => a.name.localeCompare(b.name))
}

async function findUnder(root, filename, depth) {
  try {
    const { stdout } = await execFileP('find',
      ['-L', root, '-maxdepth', String(depth), '-name', filename], { maxBuffer: 8e6 })
    return stdout.split('\n').filter(Boolean)
  } catch { return [] }
}

/* Paths /skill is willing to read: an allowlist built from the index, so it can
 * never be talked into reading a file that is not a known skill. */
const readable = new Set()
let skillCache = { at: 0, data: null }
/* Built ON DEMAND and cached. It used to be filled as a side effect of the
 * /skills route, so a fresh host process refused every read until something
 * happened to list skills first. */
async function skillIndex() {
  if (Date.now() - skillCache.at < 30_000 && skillCache.data) return skillCache.data
  const data = await readSkills()
  skillCache = { at: Date.now(), data }
  return data
}

async function findMd(root) {
  try {
    const { stdout } = await execFileP('find', ['-L', root, '-name', '*.md', '-maxdepth', '6'],
                                       { maxBuffer: 8e6 })
    return stdout.split('\n').filter(Boolean)
  } catch { return [] }
}


/** Minimal YAML front-matter reader — handles plain scalars AND the `>` / `|`
 *  block forms, which several shipped skills use and a one-line regex reads
 *  as the literal string ">". */
function parseFrontmatter(txt){
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(txt)
  if (!m) return {}
  const lines = m[1].split(/\r?\n/)
  const out = {}
  for (let i = 0; i < lines.length; i++){
    const kv = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(lines[i])
    if (!kv) continue
    const [, key] = kv
    let val = kv[2].trim()
    if (val === '>' || val === '|' || val === '>-' || val === '|-' || val === ''){
      const buf = []
      while (i + 1 < lines.length && /^[ \t]+\S/.test(lines[i + 1])) buf.push(lines[++i].trim())
      val = buf.join(' ')
    }
    out[key] = val.replace(/^["']|["']$/g, '').trim()
  }
  return out
}

async function tmuxlessFind(root, filename) {
  try {
    // -L follows symlinks. Without it six of the user's global skills were
    // invisible, including the two they use to move work between machines.
    const { stdout } = await execFileP('find', ['-L', root, '-name', filename, '-maxdepth', '6'],
                                       { maxBuffer: 4e6 })
    return stdout.split('\n').filter(Boolean)
  } catch { return [] }
}

async function readProjects() {
  const base = join(HOME, 'Projects')
  try {
    const { stdout } = await execFileP('find', [base, '-maxdepth', '1', '-type', 'd'])
    const kids = stdout.split('\n').filter(p => p && p !== base)
      .map(p => ({ path: p, name: p.split('/').pop() }))
      .filter(p => !p.name.startsWith('.'))          // .claude, .playwright-mcp, ...
      .sort((a, b) => a.name.localeCompare(b.name))
    // The roots are real working directories too — listing only their children
    // made ~/Projects itself, the place you sit to work ACROSS projects,
    // unreachable from the picker.
    return [{ path: base, name: 'Projects', root: true },
            { path: HOME,  name: 'Home',     root: true },
            ...kids]
  } catch { return [] }
}

/** Is this an existing directory we can start a session in? */
async function isDir(f) {
  try { return (await stat(f)).isDirectory() } catch { return false }
}

/* ── http ─────────────────────────────────────────────────────────────────── */

const VENDOR = {
  '/vendor/xterm.js':        '@xterm/xterm/lib/xterm.js',
  '/vendor/xterm.css':       '@xterm/xterm/css/xterm.css',
  '/vendor/addon-fit.js':    '@xterm/addon-fit/lib/addon-fit.js',
  '/vendor/addon-canvas.js': '@xterm/addon-canvas/lib/addon-canvas.js',
  '/vendor/addon-search.js': '@xterm/addon-search/lib/addon-search.js',
}
const TYPES = { '.html':'text/html', '.css':'text/css', '.js':'text/javascript',
                '.json':'application/json', '.png':'image/png', '.svg':'image/svg+xml',
                '.woff2':'font/woff2' }

const json = (res, body) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const server = createServer(async (req, res) => {
  try { await route(req, res) }
  catch (e) {
    // An async route that throws becomes an unhandled rejection, and node exits
    // on those by default. That is the classic "the localhost server just died"
    // — one malformed request, gone. Contain it here instead.
    console.error('[route error]', req.url, e?.message)
    if (!res.headersSent) res.writeHead(500, {'content-type':'application/json'})
    res.end(JSON.stringify({ error: String(e?.message ?? e) }))
  }
})

/* The host binds 127.0.0.1, which sounds like a security boundary and is not:
 * your browser is INSIDE that perimeter. Without these checks any page in any
 * tab could fire <img src="http://localhost:7331/new?cmd=claude&skip=1"> and
 * start a real Claude Code process with --dangerously-skip-permissions on this
 * machine, silently. An absent Host match also allows DNS rebinding. */
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i
const ALLOWED_ORIGINS = new Set([
  `http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`, `http://[::1]:${PORT}`,
])
const MUTATIONS = new Set(['/new', '/kill', '/rename', '/reorder', '/drop', '/clientlog',
                           '/agent-event'])

function guard(req, res) {
  if (!LOCAL_HOST.test(req.headers.host || '')) {
    res.writeHead(403, {'content-type':'application/json'})
    res.end(JSON.stringify({ error: 'bad_host' })); return false
  }
  const origin = req.headers.origin
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    res.writeHead(403, {'content-type':'application/json'})
    res.end(JSON.stringify({ error: 'forbidden_origin' })); return false
  }
  return true
}

async function route(req, res) {
  if (!guard(req, res)) return
  const url = new URL(req.url, `http://${req.headers.host}`)
  const p = url.pathname

  // Anything that changes state must be a POST: a GET is reachable from an
  // <img>, a <script> or a stylesheet, none of which a CSRF check can see.
  if (MUTATIONS.has(p) && req.method !== 'POST') {
    res.writeHead(405, {'content-type':'application/json', 'allow':'POST'})
    return res.end(JSON.stringify({ error: 'use_post' }))
  }

  if (p === '/health')   return json(res, { ok: true, tmux: TMUX, pid: process.pid })
  if (p === '/sessions') return json(res, await sessionsCached())
  if (p === '/skills')   return json(res, await skillIndex())
  if (p === '/projects') return json(res, await readProjects())
  if (p === '/conversations') return json(res, await readConversations())

  if (MUTATIONS.has(p)) sessionCache = { at: 0, data: null }
  /* Claude Code's own lifecycle events, relayed by hooks/oneterm-agent-state.sh.
   * Already behind the same guard as every mutation: POST only, Host and Origin
   * allowlisted, so a random page cannot forge a session's state. */
  if (p === '/agent-event') {
    const chunks = []; let n = 0
    for await (const c of req) { chunks.push(c); n += c.length; if (n > 8192) { req.resume(); break } }
    let m = null
    try { m = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {}
    // Validate the id shape: it becomes a Map key and a filename-safe value,
    // and an unbounded key space is how a long-lived process grows forever.
    if (!m || typeof m.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(m.id)) {
      res.writeHead(400, {'content-type':'application/json'})
      return res.end(JSON.stringify({ error: 'bad_event' }))
    }
    /* These two are rendered into the rail and persisted to disk, so bound
       them here rather than trusting the sender. Anything local can POST to
       this route, and an unbounded model string would be drawn into the DOM
       and written back out to agent-state.json on every restart. */
    if (m.ctxPct !== undefined) {
      const n = Math.round(Number(m.ctxPct))
      m.ctxPct = Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : undefined
    }
    if (m.model !== undefined) m.model = String(m.model).replace(/\s+/g, ' ').trim().slice(0, 24)
    /* Rebuild the limits object from scratch rather than forwarding what was
       sent: only these three windows are known, only two numbers each, and
       both are drawn into the DOM and persisted. An unbounded object here
       would grow agent-state.json for the life of the machine. */
    if (m.limits && typeof m.limits === 'object') {
      const clean = {}
      for (const k of ['five_hour', 'seven_day', 'spend_limit']) {
        const w = m.limits[k]
        if (!w || typeof w !== 'object') continue
        const pct = Math.round(Number(w.pct))
        const resets = Math.round(Number(w.resets))
        if (!Number.isFinite(pct)) continue
        clean[k] = { pct: Math.max(0, Math.min(100, pct)),
                     resets: Number.isFinite(resets) && resets > 0 ? resets : 0 }
      }
      m.limits = clean
    }
    applyAgentEvent(m)
    return json(res, { ok: true })
  }

  /* The chime decision is made in the browser; the state flip that caused it is
   * made here. Posting the decision back puts both in ONE log on ONE clock, so
   * a stray sound can be read off rather than reasoned about. */
  if (p === '/clientlog') {
    const chunks = []; let n = 0
    // push THEN check: testing first meant a single chunk over the cap left
    // chunks empty and logged a blank line. resume() drains the rest rather
    // than abandoning the request body mid-read.
    for await (const c of req) { chunks.push(c); n += c.length; if (n > 4096) { req.resume(); break } }
    const body = Buffer.concat(chunks).toString('utf8').slice(0, 600).replace(/\s+/g, ' ')
    console.log(`[chime] ${body}`)
    return json(res, { ok: true })
  }

  /* Drag-and-drop parity with a native terminal. A browser never exposes a
   * dropped file's real path — by design — so the bytes come to us, we write
   * them somewhere stable, and the client types THAT path into the session.
   * Same end result: you drop a screenshot, the agent gets a path it can read. */
  if (p === '/drop') {
    const raw  = (url.searchParams.get('name') || 'file').split(/[\\/]/).pop()
    /* Keep the name. This used to whitelist [A-Za-z0-9._-], which turns every
       letter of a Cyrillic filename into an underscore — a FigJam export came
       through as twenty underscores and "-2.jam". The client shell-quotes the
       path before typing it, so spaces and any script are safe end to end;
       what actually needs removing is control characters, path separators
       (already split off above), the characters Windows refuses in a name,
       and a leading dot that would hide the file or spell "..". */
    const safe = (raw
      .replace(/[\p{Cc}\p{Cf}\\/:*?"<>|]/gu, '_')
      .replace(/^\.+/, '')
      .trim() || 'file').slice(0, 120)
    const dir  = join(DROPS, new Date().toISOString().slice(0, 10))
    await mkdir(dir, { recursive: true })

    const chunks = []; let size = 0
    for await (const c of req) {
      size += c.length
      if (size > MAX_DROP) {                    // don't let a stray drop fill the disk
        res.writeHead(413, {'content-type':'application/json'})
        return res.end(JSON.stringify({ error: 'too_large', limit: MAX_DROP }))
      }
      chunks.push(c)
    }
    if (!size) { res.writeHead(400); return res.end(JSON.stringify({ error: 'empty' })) }

    // never clobber an earlier drop of the same name
    const dot = safe.lastIndexOf('.')
    const stem = dot > 0 ? safe.slice(0, dot) : safe
    const ext  = dot > 0 ? safe.slice(dot) : ''
    let target = join(dir, safe)
    for (let n = 1; await exists(target); n++) target = join(dir, `${stem}-${n}${ext}`)

    await writeFile(target, Buffer.concat(chunks))
    console.log(`[drop] ${target} (${size} bytes)`)
    return json(res, { path: target, bytes: size })
  }
  if (p === '/skill') {
    const f = url.searchParams.get('path') || ''
    await skillIndex()                            // make sure the allowlist exists
    if (!readable.has(f)) {                       // not in the index → not readable
      res.writeHead(404, {'content-type':'application/json'})
      return res.end(JSON.stringify({ error: 'unknown_skill' }))
    }
    try {
      const text = await readFile(f, 'utf8')
      return json(res, { path: f, text })
    } catch (e) {
      res.writeHead(404, {'content-type':'application/json'})
      return res.end(JSON.stringify({ error: String(e.message) }))
    }
  }
  if (p === '/reorder') {
    const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean)
    for (let i = 0; i < ids.length; i++)
      await tmux(['set-option', '-t', PREFIX + ids[i], '@oneterm_order', String(i * 10)])
    return json(res, { ok: true })
  }
  if (p === '/rename') {
    const id = url.searchParams.get('id')
    /* The row format is delimiter-separated, so a label containing the
     * delimiter shifts every field after it — a rename could forge the cwd and
     * cmd the UI displays, undoing the whole point of reporting the LIVE path. */
    const label = (url.searchParams.get('label') || '')
      .replace(/[\r\n]+/g, ' ').split('|~|').join('/').slice(0, 60).trim()
    if (id && label) await tmux(['set-option', '-t', PREFIX + id, '@oneterm_label', label])
    return json(res, { ok: true })
  }
  if (p === '/kill' && url.searchParams.get('id')) {
    await tmux(['kill-session', '-t', PREFIX + url.searchParams.get('id')])
    return json(res, { ok: true })
  }
  if (p === '/resolve') {
    // expand ~ and check it before the client offers it as a destination
    let f = (url.searchParams.get('path') || '').trim()
    if (f.startsWith('~')) f = join(HOME, f.slice(1))
    if (!f.startsWith('/')) return json(res, { ok: false })
    return json(res, { ok: await isDir(f), path: f })
  }
  if (p === '/new') {
    const q = url.searchParams
    const id = 's' + Date.now().toString(36)
    const wantCwd = q.get('cwd') || HOME
    if (!(await isDir(wantCwd))) {
      res.writeHead(400, {'content-type':'application/json'})
      return res.end(JSON.stringify({ error: 'no_such_directory', cwd: wantCwd }))
    }
    /* A conversation id reaches the command line, so it is validated to the
       shape Claude Code actually mints and nothing looser. Anything else here
       would be shell injection with extra steps. */
    const resume = q.get('resume')
    if (resume && !/^[0-9a-fA-F-]{8,64}$/.test(resume)) {
      res.writeHead(400, {'content-type':'application/json'})
      return res.end(JSON.stringify({ error: 'bad_resume_id' }))
    }
    await createSession({ id, cmd: q.get('cmd') || 'shell',
      cwd: q.get('cwd') || HOME, cols: Number(q.get('cols')), rows: Number(q.get('rows')),
      skip: q.get('skip') === '1', resume })
    return json(res, { id })
  }

  const file = VENDOR[p] ? join(ROOT, 'node_modules', VENDOR[p])
                         : join(ROOT, 'public', (p === '/' ? 'index.html' : p).replace(/^\/+/, ''))
  try {
    const body = await readFile(file)
    const ext = file.slice(file.lastIndexOf('.'))
    // The app shell must never be cached: without this Chrome kept serving a
    // stale index.html, so fixes appeared not to land at all. Vendor files are
    // versioned by package and can cache.
    const headers = { 'content-type': TYPES[ext] ?? 'text/plain' }
    if (!p.startsWith('/vendor/')) headers['cache-control'] = 'no-store, must-revalidate'
    res.writeHead(200, headers)
    res.end(body)
  } catch { res.writeHead(404).end('not found') }
}

/* ── websocket: a thin pipe between one browser pane and one tmux session ─── */

const wss = new WebSocketServer({ server, path: '/pty' })

wss.on('connection', async (ws, req) => {
  const q = new URL(req.url, 'http://x').searchParams
  const id = q.get('id')
  const cols = Number(q.get('cols')) || 120
  const rows = Number(q.get('rows')) || 32
  if (!id) { ws.close(); return }

  const name = PREFIX + id

  /* Register the message listener BEFORE the awaits below. `ws` does not hold
   * messages for a listener that is not attached yet, and there is a `tmux ls`
   * spawn AND a pty spawn between the socket opening and where this used to
   * live — so everything the client sent on open went on the floor: the first
   * resize, and the reconnect flush of keystrokes typed while the socket was
   * down. Queue here, drain once the pty exists. */
  let term = null
  const early = []
  const apply = m => {
    if (m.t === 'in') term.write(m.d)
    else if (m.t === 'resize') {
      try { term.resize(Math.max(2, m.cols|0), Math.max(1, m.rows|0)) } catch {}
      settle(name)               // a resize reflows the pane; that is not work
    }
  }
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw.toString()) } catch { return }
    if (!term){ if (early.length < 200) early.push(m); return }
    apply(m)
  })

  /* The close handler has to be registered BEFORE the awaits too, and for the
   * same reason the message listener does: `close` fires exactly once, and if
   * nothing is listening when it does, the pty is never killed. It used to be
   * registered after the spawn, which left a window — `tmux ls` plus a pty
   * spawn wide — where a socket that opened and closed leaked a tmux client
   * that lived forever. Reproduced: 5 open-then-close connections left 5
   * orphaned `tmux attach-session` processes, and one was found orphaned in
   * the wild after 7 minutes. Ordinary use hits this, because connect() closes
   * the previous socket on every session switch and every reconnect.
   * Two orphan costs beyond the process itself: the session reads attached
   * forever, and `window-size latest` lets a stale 80x24 client dictate the
   * live pane size. */
  let closed = false
  ws.on('close', () => {
    closed = true
    try { term?.kill() } catch {}
    console.log(`[detach] ${name}`)
  })

  const sessions = await listSessions()
  if (!sessions.some(s => s.id === id)) {
    // 4404 = this session does not exist. A plain close is indistinguishable
    // from a dropped connection, so the client retried a dead session forever.
    ws.send(`\r\n\x1b[31m[session ${id} is gone]\x1b[0m\r\n`)
    ws.close(4404, 'session_gone'); return
  }

  // NEVER attach with -d. It force-detaches every other client, so two open
  // viewers (a second tab, a second person) knock each other off in turn and
  // each auto-reconnects — an infinite reattach war that reads as the whole
  // screen strobing. Without -d they simply mirror, and `window-size latest`
  // (set at creation) means the most recent client decides the pane size.
  try {
    term = pty.spawn(TMUX, ['-u', 'attach-session', '-t', name], {
      name: 'xterm-256color', cols, rows, cwd: HOME,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor',
             LANG: LOCALE, LC_ALL: LOCALE,
             // 15;0 = light bg, 0;15 = dark bg. Apps that respect COLORFGBG
             // pick a readable palette themselves rather than being overridden.
             COLORFGBG: q.get('light') === '1' ? '0;15' : '15;0',
             ONETERM: '1', ONETERM_SESSION: id },
    })
  } catch (e) {
    ws.send(`\r\n\x1b[31m[attach failed: ${e.message}]\x1b[0m\r\n`); ws.close(); return
  }
  settle(name)
  console.log(`[attach] ${name} ${cols}x${rows}`)

  // Anything that arrived while tmux was spawning, in the order it was sent.
  if (early.length) console.log(`[attach] ${name} draining ${early.length} early msg`)
  for (const m of early) apply(m)
  early.length = 0

  // The other half of the race: the socket closed while we were spawning, so
  // the handler above ran with term still null and had nothing to kill. Logged
  // explicitly, because otherwise this reads as a [detach] that arrives BEFORE
  // its own [attach] and looks like the log is lying.
  if (closed) {
    try { term.kill() } catch {}
    console.log(`[attach] ${name} aborted before spawn — pty killed`)
    return
  }

  term.onData(d => { if (ws.readyState === 1) ws.send(d) })
  term.onExit(() => { if (ws.readyState === 1) ws.close() })

  // Detaching the PTY client leaves tmux — and everything in it — running.
  // (The close handler is registered above, before the awaits.)
})

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    // Someone is already serving this port — almost always another copy of us.
    // Exiting 0 is correct and, with KeepAlive{SuccessfulExit:false}, launchd
    // leaves it alone instead of crash-looping on a stack trace.
    console.log(`port ${PORT} already in use — assuming another oneterm host; exiting quietly`)
    process.exit(0)
  }
  console.error('fatal:', e)
  process.exit(1)
})
process.on('SIGTERM', () => process.exit(0))
process.on('uncaughtException', (e) => {
  console.error('[uncaught]', e?.stack ?? e)
  process.exit(1)          // launchd restarts us; tmux kept the work
})
process.on('unhandledRejection', (e) => {
  console.error('[unhandled rejection]', e?.stack ?? e)
  process.exit(1)
})

/* Belt and braces for the locale hole above: stamp the tmux SERVER too, so
 * anything created outside createSession — a new window, a pane split, a
 * session made by hand — is born UTF-8 as well. Sessions already running keep
 * the environment their processes started with; those have to be recreated. */
async function stampServerLocale() {
  /* Only stamp a server that already exists. set-environment would START one,
     and this host boots at login for a user who may never open oneterm — so
     the locale fix would have quietly added an always-on tmux process. Nothing
     is lost by skipping: createSession stamps LANG/LC_ALL on the session
     itself, which is the authoritative path. */
  if (!(await tmux(['list-sessions'])).trim()) return
  await tmux(['set-environment', '-g', 'LANG', LOCALE])
  await tmux(['set-environment', '-g', 'LC_ALL', LOCALE])
}

server.listen(PORT, '127.0.0.1', async () => {
  await stampServerLocale()
  await loadHookState()
  console.log(`oneterm → http://localhost:${PORT}  (tmux: ${TMUX}, locale: ${LOCALE})`)
})
