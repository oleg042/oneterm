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

/** Working if ANY agent in the session is working. undefined = never heard. */
export function hookWorking(entry) {
  const agents = entry?.agents
  if (!agents) return undefined
  const states = Object.values(agents)
    .map(a => a?.working)
    .filter(w => w !== undefined)
  if (!states.length) return undefined
  return states.some(Boolean)
}

/** Fold one hook event into a session entry. Returns the entry, mutated. */
export function applyEvent(entry, { action, claudeSession, transcript }, now = Date.now()) {
  entry ??= { agents: {} }
  entry.agents ??= {}
  entry.at = now
  if (transcript) entry.transcript = transcript
  // ONETERM_SESSION is stamped on the TMUX session, so every pane, window and
  // subprocess inside it inherits the same id. Bucket by the Claude session so
  // a second `claude` — another window, or one a script shelled out to —
  // cannot declare the first one finished. No id means python3 was missing and
  // we only got id+action; bucket those together rather than drop the event.
  const key = claudeSession || '_'
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
export function decideWorking({ hook, paneWorking, regexWorking, quietSince, now = Date.now(), missedStopMs }) {
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
