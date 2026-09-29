/* The awake switch — keep the Mac running with the lid closed.
 *
 * `pmset -a disablesleep 1` is the only setting that does that: caffeinate
 * holds off idle sleep but a closed lid still puts the machine to sleep. It
 * needs root, and this host runs under launchd with no terminal to type a
 * password into, so bin/install-sleep-switch.sh installs a sudoers rule that
 * allows exactly the two commands below and nothing else.
 *
 * Pure, so test/sleep.test.mjs runs the text that ships. The host sends
 * pmsetArgs() and the rule allows pmsetArgs(); keeping both here is what stops
 * them drifting apart, which would make the switch quietly ask for a password. */

// Absolute: sudoers matches the command PATH, and launchd hands us no PATH.
export const PMSET = '/usr/bin/pmset'
export const SUDOERS_FILE = '/etc/sudoers.d/oneterm-sleep'

/** true = sleep is disabled (stays awake), false = may sleep, null = unknown. */
export function parseSleepDisabled(text) {
  // Anchored on the whole key: "Sleep On Power Button 1" also starts with Sleep.
  const m = /^\s*SleepDisabled\s+(\d+)\s*$/m.exec(String(text ?? ''))
  return m ? m[1] !== '0' : null
}

export function pmsetArgs(on) {
  return ['-a', 'disablesleep', on ? '1' : '0']
}

/**
 * The whole sudoers file. The user name is REFUSED rather than escaped if it
 * is anything but a plain account name: it lands in a file root reads on
 * every sudo, and "x ALL=(ALL) ALL" as a name would be the entire attack.
 */
export function sudoersRule(user) {
  if (typeof user !== 'string' || !/^[a-z_][a-z0-9_.-]{0,31}$/i.test(user))
    throw new Error(`refusing to write a sudoers rule for user ${JSON.stringify(user)}`)
  const cmd = on => [PMSET, ...pmsetArgs(on)].join(' ')
  return '# oneterm: the "awake" switch in the rail. Allows exactly these two\n' +
         '# commands without a password, and nothing else.\n' +
         '# Remove with: bash bin/install-sleep-switch.sh --uninstall\n' +
         `${user} ALL=(root) NOPASSWD: ${cmd(false)}, ${cmd(true)}\n`
}

/* ── setting it up from the switch itself ─────────────────────────────────
   The first click with no rule installed asks macOS for your password — the
   standard administrator dialog — and runs rootInstallCommand as root. No
   terminal, no copy-paste. */

const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`

/**
 * The shell command the dialog runs AS ROOT to install `rule`.
 *
 * The rule travels INSIDE the command, quoted — never through a temp file.
 * A file you own could be swapped by any process running as you while the
 * password dialog sits open, and root would then install whatever it found:
 * "ALL=(ALL) NOPASSWD: ALL" by the back door. It is staged under a dotted
 * name, which sudo skips in sudoers.d, checked by visudo, and only then moved
 * into place — so a broken file, which can lock sudo out of the whole
 * machine, never goes live even for an instant.
 *
 * target/owner/group exist so the test can run this exact text unprivileged.
 */
export function rootInstallCommand(rule, { target = SUDOERS_FILE, owner = 'root', group = 'wheel' } = {}) {
  const staged = target.replace(/[^/]+$/, name => `.${name}.new`)
  return [
    'umask 077',
    `printf '%s' ${shq(rule)} > ${shq(staged)}`,
    `/usr/sbin/chown ${shq(owner)}:${shq(group)} ${shq(staged)}`,
    `/bin/chmod 0440 ${shq(staged)}`,
    `/usr/sbin/visudo -c -f ${shq(staged)} >/dev/null`,
    `/bin/mv -f ${shq(staged)} ${shq(target)}`,
  ].join(' && ') + ` || { /bin/rm -f ${shq(staged)}; exit 1; }`
}

/**
 * osascript arguments that run `command` as root behind the macOS
 * administrator password dialog. The command and prompt are ARGUMENTS, read
 * with `item N of argv` — nothing is spliced into the AppleScript text, so
 * nothing in them can change what the script does.
 */
export function osascriptArgs(command, prompt) {
  return ['-e', 'on run argv',
          '-e', 'do shell script (item 1 of argv) with prompt (item 2 of argv) with administrator privileges',
          '-e', 'end run',
          command, prompt]
}
