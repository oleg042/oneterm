#!/bin/bash
# One-time setup for the "awake" switch in oneterm's rail.
#
# The switch flips `pmset -a disablesleep`, the only setting that keeps a Mac
# running with the lid closed. That needs root, and the host runs under launchd
# with no terminal to ask for a password in. So this installs a sudoers rule
# that lets YOU run exactly `pmset -a disablesleep 0` and `… 1` without a
# password — those two commands and nothing else.
#
# Run it as yourself in a shell tab; it asks for your password once:
#   bash bin/install-sleep-switch.sh               install
#   bash bin/install-sleep-switch.sh --uninstall   remove
#   bash bin/install-sleep-switch.sh --print       show the rule, change nothing
#   bash bin/install-sleep-switch.sh --print-command   show the root command, change nothing
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FILE=/etc/sudoers.d/oneterm-sleep

if [ "${1:-}" = "--uninstall" ]; then
  sudo rm -f "$FILE"
  echo "✓ removed $FILE — the switch will ask for this setup again"
  exit 0
fi

# As root, id -un says "root" and the rule would be written for the wrong user.
if [ "$(id -u)" = 0 ]; then
  echo "run this as yourself, not with sudo — it asks for the password itself"
  exit 1
fi

# The rule text comes from sleep.mjs, the module the host runs, so the commands
# it allows cannot drift from the commands the host sends.
RULE="$(node --input-type=module -e '
  const { sudoersRule } = await import(process.argv[1])
  process.stdout.write(sudoersRule(process.argv[2]))' "$DIR/sleep.mjs" "$(id -un)")"

# The exact command the password-dialog path runs as root (sleep.mjs). The
# rule travels INSIDE it, quoted — never through a temp file: a file you own
# could be rewritten by any process running as you while sudo waits for your
# password, and root would install whatever it found there. It stages the rule
# under a name sudo ignores, checks it with visudo, and only then moves it in.
CMD="$(node --input-type=module -e '
  const { sudoersRule, rootInstallCommand } = await import(process.argv[1])
  process.stdout.write(rootInstallCommand(sudoersRule(process.argv[2])))' "$DIR/sleep.mjs" "$(id -un)")"

case "${1:-}" in
  --print)         printf '%s\n' "$RULE"; exit 0 ;;
  --print-command) printf '%s' "$CMD"; exit 0 ;;
  '') ;;
  *) echo "unknown option: $1 (use --print, --print-command or --uninstall)"; exit 1 ;;
esac

echo "installing $FILE (sudo will ask for your password once)…"
sudo /bin/sh -c "$CMD" || { echo "✗ the rule was not installed (visudo refused it, or sudo failed) — nothing changed"; exit 1; }
# Belt and braces: the rule parsed alone; make sure sudoers as a whole still does.
if ! sudo /usr/sbin/visudo -c >/dev/null; then
  sudo rm -f "$FILE"
  echo "✗ sudoers stopped parsing with the rule in place — removed it again"
  exit 1
fi

# Forget the password sudo just cached, so this proves the rule and not the cache.
sudo -k
if sudo -n -l /usr/bin/pmset -a disablesleep 1 >/dev/null 2>&1; then
  echo "✓ done — the awake switch in oneterm works now"
else
  echo "✗ installed, but sudo still wants a password for pmset — check $FILE"
  exit 1
fi
