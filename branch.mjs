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
