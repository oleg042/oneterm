/* The awake switch: reading whether the Mac may sleep, and the one sudoers rule
 * that lets the host change it. Pure, so the test runs what ships — the rule
 * text in particular, because the host sends exactly the commands the rule
 * allows, and if those two ever drift the switch silently asks for a password.
 *   node test/sleep.test.mjs
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSleepDisabled, sudoersRule, pmsetArgs, PMSET } from '../sleep.mjs'

let pass = 0, fail = 0
const ok  = m => { console.log(`  \x1b[32m✓\x1b[0m ${m}`); pass++ }
const bad = m => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); fail++ }
const eq = (got, want, m) => JSON.stringify(got) === JSON.stringify(want)
  ? ok(m) : bad(`${m}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`)

console.log('\noneterm awake switch\n')

// ── reading pmset -g ────────────────────────────────────────────────────────
/* Captured from a real `pmset -g` on macOS, tabs and all. Note the second
   line of settings: "Sleep On Power Button" also starts with Sleep, so the
   parser has to anchor on the whole key. */
const PMSET_G = (v) => 'System-wide power settings:\n' +
  ` SleepDisabled\t\t${v}\n` +
  'Currently in use:\n' +
  ' standby              1\n' +
  ' Sleep On Power Button 1\n' +
  ' sleep                1 (sleep prevented by caffeinate, caffeinate, coreaudiod, powerd)\n' +
  ' displaysleep         5\n'
eq(parseSleepDisabled(PMSET_G(1)), true,  'SleepDisabled 1 → the Mac stays awake')
eq(parseSleepDisabled(PMSET_G(0)), false, 'SleepDisabled 0 → the Mac may sleep')
eq(parseSleepDisabled(' Sleep On Power Button 1\n sleep 1\n'), null,
   'no SleepDisabled line → unknown, not "off" (other Sleep* keys do not count)')
eq(parseSleepDisabled(''), null, 'empty output → unknown')
eq(parseSleepDisabled(undefined), null, 'no output → unknown')

// ── the commands ────────────────────────────────────────────────────────────
eq(PMSET, '/usr/bin/pmset', 'pmset by absolute path — sudoers matches paths, and launchd gives no PATH')
eq(pmsetArgs(true),  ['-a', 'disablesleep', '1'], 'on  = pmset -a disablesleep 1')
eq(pmsetArgs(false), ['-a', 'disablesleep', '0'], 'off = pmset -a disablesleep 0')

// ── the sudoers rule ────────────────────────────────────────────────────────
const rule = sudoersRule('olegtest')
const allows = rule.split('\n').filter(l => l && !l.startsWith('#')).join(' ')
for (const on of [true, false]) {
  const cmd = [PMSET, ...pmsetArgs(on)].join(' ')
  allows.includes(cmd) ? ok(`the rule allows exactly what the host sends: ${cmd}`)
                       : bad(`the rule does not allow: ${cmd}`)
}
/NOPASSWD:/.test(allows) && /^olegtest ALL=\(root\) NOPASSWD:/.test(allows)
  ? ok('for this user only, as root, without a password') : bad(`rule shape: ${allows}`)
!/ALL\s*$|,\s*ALL\b|\*/.test(allows.replace(/^olegtest ALL=\(root\)/, ''))
  ? ok('no wildcard, no ALL command — two commands and nothing else')
  : bad(`rule is broader than two commands: ${allows}`)
rule.endsWith('\n') ? ok('ends with a newline (sudoers ignores an unterminated last line)')
                    : bad('rule has no trailing newline')

// The real validator, on the real text. visudo -c -f runs unprivileged.
const dir = mkdtempSync(join(tmpdir(), 'oneterm-sudoers-'))
try {
  const f = join(dir, 'rule'); writeFileSync(f, rule)
  try { execFileSync('/usr/sbin/visudo', ['-c', '-f', f], { stdio: 'pipe' }); ok('visudo -c accepts it') }
  catch (e) { bad(`visudo rejects it: ${e.stderr}`) }
} finally { rmSync(dir, { recursive: true, force: true }) }

/* The user name lands in a file root reads on every sudo. Anything that is not
   a plain account name could widen the rule — "x ALL=(ALL) ALL\n" is the whole
   attack — so it is refused rather than escaped. */
for (const evil of ['', 'x ALL=(ALL) ALL', 'a\nb', 'root,other', '%admin', 'a b', undefined]) {
  let threw = false
  try { sudoersRule(evil) } catch { threw = true }
  threw ? ok(`refuses user ${JSON.stringify(evil)}`) : bad(`accepted user ${JSON.stringify(evil)}`)
}

// ── the installer writes the same rule ─────────────────────────────────────
/* --print runs everything except the sudo steps, so this proves the file the
   installer would put in /etc/sudoers.d is byte-for-byte the rule above. */
try {
  const me = execFileSync('id', ['-un'], { encoding: 'utf8' }).trim()
  const printed = execFileSync('bash', [new URL('../bin/install-sleep-switch.sh', import.meta.url).pathname,
                                        '--print'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  printed === sudoersRule(me) ? ok('the installer writes exactly this rule, for you')
                              : bad(`installer printed:\n${printed}`)
} catch (e) { bad(`installer --print failed: ${e.stderr || e.message}`) }

console.log(`\n  ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
console.log('  the switch and its rule agree.\n')
