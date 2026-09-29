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

if [ "${1:-}" = "--print" ]; then
  printf '%s\n' "$RULE"
  exit 0
fi

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
printf '%s\n' "$RULE" > "$TMP"

# A broken file in /etc/sudoers.d can lock sudo out entirely, so nothing is
# installed that visudo has not parsed first.
/usr/sbin/visudo -c -f "$TMP" >/dev/null || { echo "✗ the rule failed visudo — not installing"; exit 1; }

echo "installing $FILE (sudo will ask for your password once)…"
sudo install -m 0440 -o root -g wheel "$TMP" "$FILE"
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
