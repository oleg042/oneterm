/* Session state detection, split out of server.mjs for ONE reason: so the tests
 * can run the patterns that actually ship. Every regex here has been wrong at
 * least once, always the same way — an assumption about where Claude Code draws
 * something, never verified against a real pane. test/detect.test.mjs runs this
 * module against captures taken from live sessions, so the next assumption gets
 * caught by a fixture instead of by the operator noticing a wrong dot.
 *
 * Pure and stateless on purpose. The latch, the settle window and the tail
 * cache all stay in server.mjs, because they are time-dependent and this has to
 * be callable with nothing but a string. */

/* A live prompt sits at the BOTTOM of the pane, so that is the only place worth
 * looking for one. Searching all 2000 characters meant a question asked and
 * answered ten screens ago still counted as a prompt awaiting an answer. */
export function liveTail(tail, lines = 25) {
  return tail.split('\n').slice(-lines).join('\n')
}

/* How far up "live" reaches. MEASURED, not assumed: the status line is normally
 * the last line, but Claude Code draws the expanded agent panel BELOW it, which
 * pushed it to 4 from the bottom and outside a 3-line window — a session with
 * two running background shells then read as idle. Fixtures in test/fixtures
 * record the real range. */
export const LIVE_LINES = 20

/* How much of the pane the detector is allowed to see.
 *
 * Lines, not bytes. A byte cap is a different number of lines on every
 * terminal width — 2000 chars is ~25 lines at 80 columns but only ten at 191 —
 * so on a wide pane the window silently shrank below LIVE_LINES and cut the
 * live spinner off entirely. Shared with server.mjs and with the tests so all
 * three shape the pane identically; a test that trimmed differently from the
 * host was how this stayed invisible. */
export const PANE_LINES = 60
export const PANE_CHARS = 24000
export const paneWindow = raw =>
  raw.replace(/\s+$/, '').split('\n').slice(-PANE_LINES).join('\n').slice(-PANE_CHARS)

export const WAITING = [
  /* /Do you want (to|me)/ was here and had to go: it is PROSE, not a prompt.
   * Claude Code ends turns with "do you want me to build it?" constantly, and
   * that sentence merely SITTING on screen pinned the session to "needs you"
   * and rang the bell. Everything left is STRUCTURAL — a shape only a live
   * prompt draws. The real permission prompt still matches, via its numbered
   * selector below. */
  /Enter to confirm/i,
  /\(y\/n\)/i,
  /Press Enter to/i,
  /❯\s*\d+\.\s/,          // Claude Code's numbered choice list
  /New MCP server found/i,
  /\bProceed\?/i,
]
/* Deliberately NOT matched: "N MCP servers need authentication". That is a
 * BANNER printed once at startup and it lives on screen forever, so matching it
 * pinned a session to "needs you" for its whole life — including while it was
 * visibly working. */

/* Claude Code redraws its input box and status line constantly — a ticking
 * context %, a blinking cursor — so "the pane changed since last poll" is true
 * forever and a session stuck on "working". Detect the POSITIVE markers it
 * prints only while a turn is running instead.
 * These are matched against the WHOLE tail. */
/* What may sit in the spinner slot before the ellipsis.
 *
 * A single word, as before — that is still what separates the spinner from a
 * transcript sentence that happens to end in "…". But a LETTER, not [A-Za-z]:
 * Claude Code's verb list has "Beboppin'", "Flambéing" and "Sautéing", and the
 * verb is picked once per turn, so a turn that drew one of those was invisible
 * from its first second to its last. The hook's start held it for 60s, then the
 * stale-hook fallback believed the blank pane and rang "done" on a turn that was
 * still running. Checked against all 189 verbs in the 2.1.299 binary.
 *
 * Plus Claude Code's own multi-word system messages, which use the same slot.
 * "Compacting conversation…" is drawn for the WHOLE of an auto-compaction —
 * 64 to 166 seconds across 81 compactions in the transcripts — and read as an
 * idle pane, which is how a working tab chimed "done" mid-run (2026-10-14).
 * The hook phases around it draw "Running PreCompact hooks…" and friends. */
const VERB = String.raw`\p{L}[\p{L}\p{N}_'’-]*`
const SYSTEM_SPINNER = String.raw`Compacting conversation|Running (?:PreCompact|PostCompact|SessionStart) hooks`
const SPIN = `(?:${SYSTEM_SPINNER}|${VERB})`

export const WORKING = [
  /esc to interrupt/i,
  /* /still (thinking|working)/i was here and had to go: it is PROSE, not a
   * marker. It was the last unanchored pattern in this list, matched anywhere
   * in the tail, and no captured pane ever showed Claude Code drawing it as
   * status — the binary uses "Still working." for a phone check-in and the
   * rest are phrases people TYPE. What it did match was an answer that said
   * "asks first if Claude is still working in it": that sentence sitting on
   * screen flapped an idle session work 0->1 against the hook's Stop every
   * poll. A live turn is already caught by the anchored spinner shapes below.
   * Fixture: status2_spin0_prose_still_working_prompt0.pane. */
  /* The elapsed timer is multi-unit once a run passes a minute — "(3m 9s ·" —
   * so a \(\d+s pattern stops matching exactly when a run is long enough to
   * care about.
   *
   * The leading … is load-bearing, added after the [state] log caught this
   * reporting work on a session sitting at an EMPTY PROMPT with no spinner.
   * Bare "(<time>" matches two things that are not a running turn: VISIBLE
   * TRANSCRIPT of finished steps — an agent that ended "· 2m 0s" — and the
   * "/goal active (41m)" badge, drawn for a goal's entire life. The first
   * flapped work 1->0->1 as lines scrolled, one false "done" chime per flap;
   * the second pinned a session busy for 41 minutes. Only the live spinner
   * writes "word… (elapsed", so the ellipsis stops both. */
  /* Anchored to the START of a line, with room for the spinner glyph. The
   * leading … alone was not enough: a transcript line can END in an ellipsis
   * and be followed by a collapsed duration — "…, writes … (5m 48s · 2 lines)"
   * — which is a FINISHED tool call, not a running turn. That shape sat three
   * lines above a live spinner in a real pane, so any window wide enough to
   * reach the real marker also swallowed the fake one. Only the spinner slot
   * puts "word… (elapsed" at the head of its own line. */
  new RegExp(String.raw`^\s*(?:\S{1,2}\s+)?${SPIN}…\s*\((?:\d+[hms]\s*)+[·)]`, 'mu'),
  /* The spinner GLYPH animates through a set we cannot enumerate reliably, so
   * match the SHAPE instead: a mark, a word ending in an ellipsis, then the
   * timer's opening paren. Enumerating glyphs made detection blink at
   * animation speed, and every blink read as "the run finished". */
  new RegExp(String.raw`^\s*\S{1,2}\s+${SPIN}…\s*\(`, 'mu'),
  /* API trouble REPLACES the spinner line rather than sitting beside it, so a
   * turn stalled on the network showed no marker at all — and Claude Code
   * raises the stall banner after only 20s without a streamed byte. Each is
   * matched on its own structure (the "·"-separated retry suffix), never on
   * the phrase alone, so prose about retrying cannot pin a session busy. The
   * other two banners ("next try in … · esc to interrupt") are already caught
   * by the interrupt hint above. */
  /^\s*\S{0,2}\s*Waiting for API response\s*·\s*will retry in\b/mu,
  /^\s*\S{0,2}\s*No response from the API after\b[^\n]*·\s*retrying\b/mu,
  /·\s*Retrying in [^·\n]{1,40}·\s*attempt \d+\/\d+\s*$/mu,
]

/* Matched against the LIVE window only. */
export const WORKING_LIVE = [
  /* A spinner with no elapsed timer YET — "✳ Ideating…". Everything above
   * requires a "(" on the line, so the opening stretch of every turn was
   * invisible. Single word before the ellipsis on purpose: that is what
   * separates the spinner slot from a transcript sentence ending in one. */
  new RegExp(String.raw`^\s*\S{1,2}\s+${SPIN}…\s*$`, 'mu'),
]

/* Everything above describes the FOREGROUND turn, which is why a session could
 * read "idle" with real work in flight: the main loop finishes, sits at an
 * empty prompt, and a backgrounded shell keeps running. The status line is the
 * only place that says so. Matched against the LIVE window. */
/* One counted kind of background work in the status line's "Waiting for" list. */
const WAIT_ITEM = String.raw`[1-9]\d*\s+(?:background\s+|dynamic\s+)?(?:agents?|workflows?|shells?|tasks?)`
export const BACKGROUND = [
  /* Prose-proof: the status-line segment is followed by another middot or the
   * end of the line, whereas the TRANSCRIPT writes "· 1 shell still running",
   * which this refuses. That is what lets the window be wide enough to clear
   * the agent panel without that sentence pinning a session busy forever. */
  /·\s*[1-9]\d*\s+shells?\s*(?=·|$)/m,
  /* A turn that handed off to a BACKGROUND AGENT. The main loop finishes and
   * parks at an empty prompt, the hook fires Stop, and every foreground
   * pattern misses — while an agent runs for ten more minutes and the rail
   * reads idle. This is Claude Code's own status-line text, so it is anchored
   * to a whole line (with room for the animating spinner glyph in front) and
   * refuses the same sentence written inside a transcript paragraph.
   *
   * Deliberately NOT the agent panel below it: "⏺ main / ◯ general-purpose"
   * could not be shown to drop when an agent finishes, and neither could the
   * "← N agents" counter — sampling all ten live sessions found "← 7 agents"
   * present on nine of them, including completely idle ones. A counter that
   * never returns to zero pins a session busy for life. */
  /* It is a LIST: Claude Code names every kind of background work in one line
   * — "Waiting for 1 background agent and 1 dynamic workflow to finish". This
   * took exactly "N background agents", so a line naming two kinds read as
   * idle while a review workflow and an agent ran (2026-10-07). Now any counted
   * agents, workflows, shells or tasks, joined by commas and "and". */
  new RegExp(String.raw`^\s*\S{0,2}\s*Waiting for ${WAIT_ITEM}` +
             String.raw`(?:(?:\s*,\s*(?:and\s+)?|\s+and\s+)${WAIT_ITEM})*\s+to finish\s*$`, 'm'),
]
/* "← N agents" is deliberately NOT a marker. Three minutes of sampling a live
 * session showed "1 shell · ← 7 agents" completely static, so it could not be
 * shown to drop when an agent finishes, and a counter that never returns to
 * zero pins a session busy for life — the MCP-banner trap again. If the [state]
 * log shows a session going work 0->1 via BACKGROUND and never back, that is
 * the tell. */

/* The whole decision, as a pure function of the pane text.
 * Returns { waiting, fg, bg, working, why } — fg and bg are separate because
 * only FOREGROUND work may override a live prompt: a permission prompt with a
 * shell running behind it is still blocked on you. */
export function classify(tail, cmd) {
  const live = liveTail(tail, LIVE_LINES)
  const isClaude = cmd === 'claude'
  const fgRe = isClaude
    ? (WORKING.find(re => re.test(tail)) ?? WORKING_LIVE.find(re => re.test(live)))
    : undefined
  const bgRe = isClaude ? BACKGROUND.find(re => re.test(live)) : undefined
  const waitRe = WAITING.find(re => re.test(liveTail(tail)))
  return {
    waiting: !!waitRe && !fgRe,          // actively printing is never "needs you"
    fg: !!fgRe,
    bg: !!bgRe,
    working: !!(fgRe || bgRe),
    why: String(fgRe ?? bgRe ?? waitRe ?? 'no marker'),
  }
}

/* ── which tabs are running Claude Code ───────────────────────────────────
 * A tab's kind (@oneterm_cmd) was decided once, at launch, and only ever moved
 * claude -> shell, when the claude it launched exited. Typing `claude` back
 * into that shell — which the exit message itself tells you to do — left the
 * tab wearing SH while Claude ran in it, so it was judged by the shell rule:
 * any change on screen is work. Claude's fullscreen view redraws on every
 * scroll, and scrolling an idle tab rang "done" (2026-10-14).
 *
 * The process table is the fact. pane_current_command is not: it reads "zsh"
 * for a claude the wrapper launched and a version string ("2.1.282") for one
 * typed by hand. argv[0] is "claude" either way. */

/** Parse `ps -axo pid=,ppid=,args=` into parent links and command lines. */
export function processTable(psText) {
  const args = new Map(), kids = new Map()
  for (const line of String(psText).split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
    if (!m) continue
    const pid = Number(m[1]), ppid = Number(m[2])
    args.set(pid, m[3])
    if (!kids.has(ppid)) kids.set(ppid, [])
    kids.get(ppid).push(pid)
  }
  return { args, kids }
}

/* An INTERACTIVE claude. `claude -p` is a script calling the model and exiting
 * — a shell tab running a job that shells out to it is still a shell tab. And
 * the wrapper's own `zsh -l -c claude …` names claude only in its arguments,
 * so argv[0] is what is checked, never the whole line. */
export function isInteractiveClaude(cmdline) {
  const argv = String(cmdline).trim().split(/\s+/)
  if (!/(?:^|\/)claude$|\/claude\/versions\/[^/]+$/.test(argv[0] ?? '')) return false
  return !argv.some(a => a === '-p' || a === '--print')
}

/** Is an interactive claude this pane's process or any descendant of it? */
export function runsClaude(panePid, table) {
  const seen = new Set(), stack = [Number(panePid)]
  while (stack.length) {
    const pid = stack.pop()
    if (seen.has(pid)) continue
    seen.add(pid)
    const cmd = table.args.get(pid)
    if (cmd !== undefined && isInteractiveClaude(cmd)) return true
    stack.push(...(table.kids.get(pid) ?? []))
  }
  return false
}
