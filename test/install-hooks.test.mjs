#!/usr/bin/env node
/* Exercises bin/install-hooks.mjs against throwaway ~/.claude directories.
 *   node test/install-hooks.test.mjs
 *
 * This installer edits a file oneterm does not own and that other tools write
 * to as well. Getting it wrong means breaking Claude Code, not just oneterm —
 * so every scenario a real machine can present is pinned here: no config at
 * all, a config with no hooks, a config already carrying another tool's hook,
 * a re-run, an uninstall, and a file we cannot parse. */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const INSTALLER = join(ROOT, 'bin', 'install-hooks.mjs')
let pass = 0, fail = 0
const ok  = m => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${m}`) }
const bad = m => { fail++; console.log(`  \x1b[31m✗\x1b[0m ${m}`) }

const homes = []
function fakeHome(settings) {
  const dir = mkdtempSync(join(tmpdir(), 'oneterm-claude-'))
  homes.push(dir)
  if (settings !== undefined) writeFileSync(join(dir, 'settings.json'), settings)
  return dir
}
function run(home, ...args) {
  return execFileSync('node', [INSTALLER, ...args],
    { env: { ...process.env, CLAUDE_HOME: home }, encoding: 'utf8' })
}
const settingsOf = home => JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'))
const ourHooks = s => Object.entries(s.hooks ?? {}).flatMap(([ev, arr]) =>
  arr.flatMap(e => (e.hooks ?? []).filter(h => h.command?.includes('oneterm-agent-state')).map(() => ev)))

/* A real herdr entry, copied from the shape actually installed on this machine. */
const HERDR = {
  hooks: {
    SessionStart: [{
      matcher: '*',
      hooks: [{ type: 'command', command: "bash '/Users/x/.claude/hooks/herdr-agent-state.sh' session", timeout: 10 }],
    }],
  },
}

console.log('\n1. a brand new machine — no ~/.claude/settings.json at all')
{
  const home = fakeHome(undefined)
  run(home)
  const s = settingsOf(home)
  const evs = ourHooks(s).sort()
  JSON.stringify(evs) === JSON.stringify(['SessionStart', 'Stop', 'UserPromptSubmit'])
    ? ok('creates settings.json with all three events')
    : bad(`expected 3 events, got ${JSON.stringify(evs)}`)
  existsSync(join(home, 'hooks', 'oneterm-agent-state.sh'))
    ? ok('copies the hook script into ~/.claude/hooks/')
    : bad('hook script was not copied')
  const mode = (statSync(join(home, 'hooks', 'oneterm-agent-state.sh')).mode & 0o777)
  mode & 0o111 ? ok(`hook is executable (${mode.toString(8)})`) : bad(`hook not executable (${mode.toString(8)})`)
}

console.log('\n2. settings.json exists but has no hooks block')
{
  const home = fakeHome(JSON.stringify({ model: 'opus', theme: 'dark' }, null, 2))
  run(home)
  const s = settingsOf(home)
  s.model === 'opus' && s.theme === 'dark'
    ? ok('unrelated settings survive untouched')
    : bad('clobbered unrelated settings')
  ourHooks(s).length === 3 ? ok('adds our three events') : bad('did not add our events')
}

console.log('\n3. another tool already owns a hook (the herdr case)')
{
  const home = fakeHome(JSON.stringify(HERDR, null, 2))
  run(home)
  const s = settingsOf(home)
  const herdrStill = JSON.stringify(s.hooks.SessionStart)
    .includes('herdr-agent-state.sh')
  herdrStill ? ok("herdr's hook survives") : bad("herdr's hook was destroyed")
  ourHooks(s).length === 3 ? ok('ours added alongside it') : bad('ours missing')
  s.hooks.SessionStart.length === 2
    ? ok('SessionStart now holds both entries, not one overwriting the other')
    : bad(`SessionStart has ${s.hooks.SessionStart.length} entries`)
}

console.log('\n4. running the installer twice (upgrade / repair)')
{
  const home = fakeHome(JSON.stringify(HERDR, null, 2))
  run(home); run(home); run(home)
  const s = settingsOf(home)
  ourHooks(s).length === 3
    ? ok('three runs still leave exactly 3 of our hooks — no duplicates')
    : bad(`duplicated: ${ourHooks(s).length} entries after 3 runs`)
  JSON.stringify(s.hooks.SessionStart).includes('herdr')
    ? ok("herdr still there after three runs") : bad('herdr lost on re-run')
}

console.log('\n5. uninstall')
{
  const home = fakeHome(JSON.stringify(HERDR, null, 2))
  run(home)
  run(home, '--uninstall')
  const s = settingsOf(home)
  ourHooks(s).length === 0 ? ok('removes every oneterm entry') : bad('left ours behind')
  JSON.stringify(s.hooks?.SessionStart ?? '').includes('herdr')
    ? ok("herdr's hook still present after our uninstall")
    : bad("uninstall took herdr's hook with it")
}

console.log('\n6. a settings.json we cannot parse')
{
  const home = fakeHome('{ this is not json')
  let threw = false
  try { run(home) } catch { threw = true }
  threw ? ok('refuses rather than overwriting a file it cannot understand') : bad('overwrote an unparseable config')
  readFileSync(join(home, 'settings.json'), 'utf8') === '{ this is not json'
    ? ok('left the original file byte-identical') : bad('modified the file anyway')
}

console.log('\n7. a backup is taken before the first change')
{
  const home = fakeHome(JSON.stringify(HERDR, null, 2))
  run(home)
  existsSync(join(home, 'settings.json.oneterm.bak'))
    ? ok('settings.json.oneterm.bak written') : bad('no backup taken')
  JSON.stringify(JSON.parse(readFileSync(join(home, 'settings.json.oneterm.bak'), 'utf8'))) === JSON.stringify(HERDR)
    ? ok('backup matches the pre-install file exactly') : bad('backup does not match')
}

for (const h of homes) rmSync(h, { recursive: true, force: true })
console.log(`\n─────────────────────────────\n  ${pass} passed, ${fail} failed`)
console.log(fail ? '  installer is UNSAFE — do not ship\n' : '  installer is safe on every machine shape tested.\n')
process.exit(fail ? 1 : 0)
