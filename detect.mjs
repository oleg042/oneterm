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
export const WORKING = [
  /esc to interrupt/i,
  /still (thinking|working)/i,
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
  /^\s*(?:\S{1,2}\s+)?[A-Za-z][\w-]*…\s*\((?:\d+[hms]\s*)+[·)]/m,
  /* The spinner GLYPH animates through a set we cannot enumerate reliably, so
   * match the SHAPE instead: a mark, a word ending in an ellipsis, then the
   * timer's opening paren. Enumerating glyphs made detection blink at
   * animation speed, and every blink read as "the run finished". */
  /^\s*\S{1,2}\s+[A-Za-z][\w-]*…\s*\(/m,
]

/* Matched against the LIVE window only. */
export const WORKING_LIVE = [
  /* A spinner with no elapsed timer YET — "✳ Ideating…". Everything above
   * requires a "(" on the line, so the opening stretch of every turn was
   * invisible. Single word before the ellipsis on purpose: that is what
   * separates the spinner slot from a transcript sentence ending in one. */
  /^\s*\S{1,2}\s+[A-Za-z][\w-]*…\s*$/m,
]

/* Everything above describes the FOREGROUND turn, which is why a session could
 * read "idle" with real work in flight: the main loop finishes, sits at an
 * empty prompt, and a backgrounded shell keeps running. The status line is the
 * only place that says so. Matched against the LIVE window. */
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
  /^\s*\S{0,2}\s*Waiting for [1-9]\d*\s+background agents?\s+to finish\s*$/m,
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
