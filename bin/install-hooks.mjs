#!/usr/bin/env node
/* Install (or remove) oneterm's agent-state hook in ~/.claude/settings.json.
 *
 *   node bin/install-hooks.mjs            install / repair / upgrade
 *   node bin/install-hooks.mjs --uninstall remove every trace
 *   CLAUDE_HOME=/tmp/x node bin/install-hooks.mjs   (used by the tests)
 *
 * This edits a file the user did not ask us to touch and that other tools also
 * write to — herdr keeps its own hook in the same block. So the rules are:
 *
 *   1. NEVER clobber. Read, merge, write. Other tools' entries survive
 *      untouched, and so do any hand-written ones.
 *   2. Idempotent. Re-running replaces our entries rather than appending a
 *      second copy, which is what makes upgrades safe.
 *   3. Atomic. Write a temp file and rename, so an interrupted install cannot
 *      leave a half-written settings.json — that would break Claude Code
 *      itself, which is a far worse outcome than oneterm having no hook.
 *   4. Reversible, and back up once before the first change.
 */
import { readFile, writeFile, mkdir, copyFile, chmod, rename, access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CLAUDE_HOME = process.env.CLAUDE_HOME || join(process.env.HOME, '.claude')
const SETTINGS = join(CLAUDE_HOME, 'settings.json')
const HOOK_DIR = join(CLAUDE_HOME, 'hooks')
const HOOK_DST = join(HOOK_DIR, 'oneterm-agent-state.sh')
const HOOK_SRC = join(ROOT, 'hooks', 'oneterm-agent-state.sh')
const MARK = 'oneterm-agent-state'          // how we recognise our own entries

/* Only events that are PROVEN to exist — SessionStart and Stop are both used by
 * herdr's shipped integration, UserPromptSubmit is documented by the hookify
 * plugin. SubagentStop is deliberately absent: it can fire after the main turn
 * has already ended and would revive a finished session. */
const EVENTS = {
  SessionStart:     'session',   // link our id to Claude's session id
  UserPromptSubmit: 'start',     // a turn began
  Stop:             'stop',      // the turn ended — this is the "done" edge
}

const uninstall = process.argv.includes('--uninstall')
const exists = p => access(p).then(() => true, () => false)

async function readSettings() {
  try {
    const txt = await readFile(SETTINGS, 'utf8')
    if (!txt.trim()) return {}
    return JSON.parse(txt)
  } catch (e) {
    if (e.code === 'ENOENT') return {}          // fresh machine: perfectly normal
    // Anything else means the file exists but we cannot understand it. Refuse
    // rather than overwrite: a malformed settings.json is the user's, and
    // replacing it with ours would lose whatever is in there.
    throw new Error(`cannot parse ${SETTINGS} (${e.message}). Not touching it.`)
  }
}

/** Strip every oneterm entry, leaving other tools' hooks exactly as they were. */
function stripOurs(hooks) {
  const out = {}
  for (const [event, entries] of Object.entries(hooks ?? {})) {
    const kept = (entries ?? [])
      .map(entry => ({
        ...entry,
        hooks: (entry.hooks ?? []).filter(h => !String(h.command ?? '').includes(MARK)),
      }))
      // an entry whose hook list is now empty was ours alone — drop it
      .filter(entry => (entry.hooks ?? []).length > 0)
    if (kept.length) out[event] = kept
  }
  return out
}

async function main() {
  const before = await readSettings()
  const otherToolsBefore = JSON.stringify(stripOurs(before.hooks))

  const hooks = stripOurs(before.hooks)

  if (!uninstall) {
    await mkdir(HOOK_DIR, { recursive: true })
    await copyFile(HOOK_SRC, HOOK_DST)
    await chmod(HOOK_DST, 0o755)
    for (const [event, action] of Object.entries(EVENTS)) {
      ;(hooks[event] ??= []).push({
        matcher: '*',
        hooks: [{
          type: 'command',
          // sh, not bash: the script is POSIX and sh is guaranteed present.
          // Quoted, because a home directory can contain spaces.
          command: `sh '${HOOK_DST}' ${action}`,
          timeout: 5,
        }],
      })
    }
  }

  const next = { ...before }
  if (Object.keys(hooks).length) next.hooks = hooks
  else delete next.hooks

  // Prove we did not disturb anyone else before writing.
  const otherToolsAfter = JSON.stringify(stripOurs(next.hooks))
  if (otherToolsBefore !== otherToolsAfter) {
    throw new Error('refusing to write: the merge would have changed another tool\'s hooks')
  }

  if (await exists(SETTINGS) && !(await exists(SETTINGS + '.oneterm.bak'))) {
    await copyFile(SETTINGS, SETTINGS + '.oneterm.bak')
  }
  await mkdir(dirname(SETTINGS), { recursive: true })
  const tmp = SETTINGS + '.oneterm.tmp'
  await writeFile(tmp, JSON.stringify(next, null, 2) + '\n')
  await rename(tmp, SETTINGS)                    // atomic

  const others = Object.values(stripOurs(next.hooks)).flat().length
  console.log(uninstall
    ? `removed oneterm hooks from ${SETTINGS} (${others} other entr${others === 1 ? 'y' : 'ies'} untouched)`
    : `installed ${Object.keys(EVENTS).join(', ')} → ${HOOK_DST}\n` +
      `  ${others} other hook entr${others === 1 ? 'y' : 'ies'} left untouched`)
}

main().catch(e => { console.error('hook install failed:', e.message); process.exit(1) })
