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
import { parseSleepDisabled, sudoersRule, pmsetArgs, PMSET, SUDOERS_FILE,
         rootInstallCommand, osascriptArgs } from '../sleep.mjs'
import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs'

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

// ── first-click setup through the macOS password dialog ────────────────────
/* The command the dialog runs AS ROOT. Run here for real — as you, into a temp
   folder — so the test executes the exact shell text that ships. Only the
   target and owner differ, and those are parameters for this reason. */
const me = execFileSync('id', ['-un'], { encoding: 'utf8' }).trim()
const myGroup = execFileSync('id', ['-gn'], { encoding: 'utf8' }).trim()
const sh = (cmd) => { try { execFileSync('/bin/sh', ['-c', cmd], { stdio: 'pipe' }); return 0 } catch (e) { return e.status || 1 } }
{
  const d = mkdtempSync(join(tmpdir(), 'oneterm-sudoersd-'))
  try {
    const target = join(d, 'oneterm-sleep')
    const good = sudoersRule(me)
    eq(sh(rootInstallCommand(good, { target, owner: me, group: myGroup })), 0, 'the root command installs a valid rule')
    eq(existsSync(target) && readFileSync(target, 'utf8'), good, '…byte for byte')
    eq(existsSync(target) && (statSync(target).mode & 0o777).toString(8), '440', '…read-only, the mode sudo insists on')
    eq(readdirSync(d), ['oneterm-sleep'], '…and leaves no staged file behind')

    /* A rule that does not parse must never reach the live name: a broken file
       in /etc/sudoers.d can lock sudo out of the whole machine. */
    const t2 = join(d, 'other')
    const code = sh(rootInstallCommand('this is not sudoers syntax\n', { target: t2, owner: me, group: myGroup }))
    code !== 0 && !existsSync(t2) ? ok('a rule visudo rejects is not installed, and the command fails')
                                  : bad(`broken rule: exit ${code}, installed=${existsSync(t2)}`)
    eq(readdirSync(d).sort(), ['oneterm-sleep'], '…and its staged copy is cleaned up too')

    // The rule reaches the shell quoted, so any character in it arrives intact.
    const t3 = join(d, 'quoted')
    const odd = "# it's \"quoted\" $HOME `id` \\ ;\n" + good
    sh(rootInstallCommand(odd, { target: t3, owner: me, group: myGroup }))
    eq(existsSync(t3) && readFileSync(t3, 'utf8'), odd, 'quotes, $, backticks and backslashes arrive as text, never as shell')
  } finally { rmSync(d, { recursive: true, force: true }) }
}
rootInstallCommand('x\n').includes(`'${SUDOERS_FILE}'`) && rootInstallCommand('x\n').includes("chown 'root':'wheel'")
  ? ok(`by default it installs ${SUDOERS_FILE}, owned root:wheel`) : bad('default target/owner')
/* The staged copy has a dot in its name, which sudo skips in sudoers.d — so a
   half-written file is never live, even for an instant. */
rootInstallCommand('x\n').includes("/.oneterm-sleep.new'") ? ok('it stages under a dotted name sudo ignores')
                                                          : bad('staged name')

/* The AppleScript never contains the command or the rule: both travel as
   separate arguments, so nothing in them can change what the script does. */
const args = osascriptArgs('echo COMMAND', 'PROMPT TEXT')
const script = args.filter((a, i) => args[i - 1] === '-e')
script.join('\n').includes('with administrator privileges') ? ok('the dialog is the real macOS administrator prompt')
                                                           : bad('no administrator privileges in the script')
!script.join('\n').includes('COMMAND') && !script.join('\n').includes('PROMPT')
  ? ok('the command and prompt are arguments, never spliced into the script') : bad('data spliced into the AppleScript')
eq(args.slice(-2), ['echo COMMAND', 'PROMPT TEXT'], '…passed last, as argv')
{
  const d = mkdtempSync(join(tmpdir(), 'oneterm-osa-'))
  try {
    // Compile without running: proves the AppleScript parses, with no dialog.
    execFileSync('/usr/bin/osacompile', [...script.flatMap(l => ['-e', l]), '-o', join(d, 's.scpt')], { stdio: 'pipe' })
    ok('osacompile accepts the script')
  } catch (e) { bad(`osacompile rejects the script: ${e.stderr}`) }
  finally { rmSync(d, { recursive: true, force: true }) }
}

console.log(`\n  ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
console.log('  the switch and its rule agree.\n')
