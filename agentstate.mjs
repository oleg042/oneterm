/* The hook-vs-pane decision, extracted so tests run the code that ships.
 *
 * This logic has been wrong twice, in opposite directions, on the same evening:
 *   1. Treating Stop as authoritative pinned a session to "idle" while it ran
 *      visibly for nine minutes — because UserPromptSubmit is NOT the only way
 *      a turn begins (auto mode, /goal loops, resumed work all start turns with
 *      no human prompt).
 *   2. Keying state on the tmux session rather than the Claude process let two
 *      `claude` instances in one tmux session clobber each other's status.
 * Both were found by a human noticing a wrong dot, which is the worst way to
 * find anything. Hence: pure functions, and a test per failure.
 *
 * Persistence and timers stay in server.mjs; nothing here touches the clock
 * except through an injected `now`. */

/* An agent that dies without firing Stop — killed, crashed, or replaced —
 * leaves working=true behind forever, and because working is ANY agent, one
 * dead bucket pins the whole session busy. Observed in the wild within minutes
 * of shipping: a legacy bucket produced "[hook] stop working=1", a stop event
 * that left the session running. Long turns genuinely go quiet for 40+ minutes
 * with no events at all, so this has to be far longer than a turn, not shorter
 * than one. */
export const AGENT_TTL_MS = 4 * 60 * 60 * 1000

/* If the hook said "working" and the pane has looked idle for this long, the
 * stop event was probably lost — the host is restartable, and a Stop fired
 * while it was down goes nowhere. Fall back to the pane rather than pin a
 * session busy forever. Generous, because real turns pass 40 minutes. */
export const MISSED_STOP_MS = 60_000

/** Working if ANY live agent in the session is working. undefined = never heard. */
export function hookWorking(entry, now = Date.now(), ttlMs = AGENT_TTL_MS) {
  const agents = entry?.agents
  if (!agents) return undefined
  const states = Object.values(agents)
    .filter(a => a && (a.at === undefined || now - a.at < ttlMs))
    .map(a => a.working)
    .filter(w => w !== undefined)
  if (!states.length) return undefined
  return states.some(Boolean)
}

/** Fold one hook event into a session entry. Returns the entry, mutated. */
export function applyEvent(entry, { action, claudeSession, transcript, model, ctxPct, ctxSize,
                                    limits },
                           now = Date.now()) {
  entry ??= { agents: {} }
  entry.agents ??= {}

  /* Context, model and the account's rate-limit windows come from the STATUS
     LINE, which Claude Code re-renders constantly and which reports the numbers
     it computed itself. Record them before the gate below, because they are
     worth having from any event that carries them.

     limits are account-wide, so they are stamped with their own timestamp
     rather than sharing entry.at (which a status report must never touch).
     Storing them per session and SHOWING them per session are different
     things: each session only reports when it re-renders, so per-session
     display meant every tab showed a snapshot from a different moment and the
     weekly number changed as you switched tabs. The server picks the freshest
     across all sessions — see limitsAt in annotateWaiting. */
  if (model !== undefined) entry.model = model
  if (ctxPct !== undefined) entry.ctxPct = ctxPct
  if (ctxSize) entry.ctxSize = ctxSize
  if (limits && Object.keys(limits).length) { entry.limits = limits; entry.limitsAt = now }

  /* A status report is the status line talking, not the agent. It says nothing
     about whether a turn is running, and it arrives whether or not anything is
     happening. Letting it reach the bookkeeping below would refresh a dead
     agent's TTL forever — the exact failure AGENT_TTL_MS exists to end — and
     stamp entry.at on a session nobody has touched in hours. */
  if (action === 'status') return entry

  entry.at = now
  if (transcript) entry.transcript = transcript
  // ONETERM_SESSION is stamped on the TMUX session, so every pane, window and
  // subprocess inside it inherits the same id. Bucket by the Claude session so
  // a second `claude` — another window, or one a script shelled out to —
  // cannot declare the first one finished. No id means python3 was missing and
  // we only got id+action; bucket those together rather than drop the event.
  const key = claudeSession || '_'
  /* The '_' bucket only exists when python3 was unavailable, or as migrated
     state from before agents were tracked separately. The moment a real Claude
     session id shows up for this session, '_' can only be stale — and a stale
     bucket stuck on working=true pins the session busy through the OR above. */
  if (claudeSession && entry.agents._) delete entry.agents._
  const agent = (entry.agents[key] ??= {})
  agent.at = now
  if (action === 'start') agent.working = true
  else if (action === 'stop') agent.working = false
  // 'session' carries no working state — it only links our id to Claude's.
  return entry
}

/**
 * Decide whether a session is working.
 *
 * THE RULE: the hook may only ever ADD "working". It can never veto the pane.
 * A hook event is proof that something happened, never proof that nothing is.
 */
export function decideWorking({ hook, paneWorking, regexWorking, quietSince,
                                now = Date.now(), missedStopMs = MISSED_STOP_MS }) {
  if (hook === true) {
    if (paneWorking || regexWorking) {
      return { working: true, from: 'hook', why: 'hook:working', quietSince: null, latched: false }
    }
    // Hook says running, pane says nothing. Usually a quiet moment mid-turn —
    // but a Stop fired while the host was restarting is gone for good, so
    // after missedStopMs stop believing it rather than pin the session busy.
    const since = quietSince ?? now
    if (now - since > missedStopMs) {
      return { working: regexWorking, from: 'regex', why: 'regex — hook start looks stale', quietSince: since, latched: true }
    }
    return { working: true, from: 'hook', why: 'hook:working (pane quiet)', quietSince: since, latched: false }
  }
  // Stopped, or never heard from: the PANE decides. This branch is the escape
  // hatch whose absence caused failure (1) above.
  return {
    working: regexWorking,
    from: 'regex',
    why: hook === false
      ? (regexWorking ? 'pane — turn began with no prompt' : 'hook:stopped')
      : undefined,
    quietSince: null,
    latched: true,
  }
}
