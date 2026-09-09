#!/bin/bash
# oneterm installer — LaunchAgent (always running) + .app (click to open).
# Idempotent: safe to re-run after any change.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="$(command -v node)"
PORT="${PORT:-7331}"
LABEL="com.oneterm.host"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
# /Applications, not ~/Applications: Finder's sidebar and most people's mental
# model of "Applications" mean the system folder. Installing to the user one
# meant Spotlight and Finder search both came up empty.
APP="/Applications/oneterm.app"
[ -w /Applications ] || APP="$HOME/Applications/oneterm.app"
LOG="$HOME/Library/Logs/oneterm"

mkdir -p "$LOG" "$HOME/Library/LaunchAgents" "$APP/Contents/MacOS" "$APP/Contents/Resources"

# ── 1. the host, supervised by launchd ──────────────────────────────────────
# KeepAlive means: if it ever exits — crash, OOM kill, bad deploy — launchd
# restarts it. Combined with tmux owning the sessions, that makes the host
# genuinely disposable.
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$DIR/server.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key><string>$PORT</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>SHELL</key><string>${SHELL:-/bin/zsh}</string>
    <!-- Without a UTF-8 locale tmux substitutes "_" for every non-ASCII glyph,
         so box drawing, spinners and progress bars all render as underscores.
         launchd provides no LANG at all, so it must be stated here. -->
    <key>LANG</key><string>en_US.UTF-8</string>
    <key>LC_ALL</key><string>en_US.UTF-8</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>3</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$LOG/host.log</string>
  <key>StandardErrorPath</key><string>$LOG/host.err</string>
</dict>
</plist>
PLIST_EOF

# bootout is ASYNC. Calling bootstrap immediately after races the unload and
# fails with "Bootstrap failed: 5", leaving no host running at all. Wait for the
# job to actually be gone first.
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
for _ in $(seq 1 25); do
  launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1 || break
  sleep 0.2
done
launchctl bootstrap "gui/$UID" "$PLIST" || launchctl kickstart -k "gui/$UID/$LABEL"
launchctl kickstart -k "gui/$UID/$LABEL" 2>/dev/null || true

# don't report success until it actually answers
for _ in $(seq 1 30); do
  curl -sf --max-time 1 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
  sleep 0.3
done

# ── 2. the clickable app ────────────────────────────────────────────────────
# Chrome's --app mode gives a window with no tab strip and no address bar, and
# its own Dock icon — so it reads as an app, not as a browser tab among thirty.
cat > "$APP/Contents/Info.plist" <<APP_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>oneterm</string>
  <key>CFBundleDisplayName</key><string>oneterm</string>
  <key>CFBundleIdentifier</key><string>io.oneaway.oneterm</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>oneterm</string>
  <key>CFBundleIconFile</key><string>oneterm</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><false/>
</dict>
</plist>
APP_EOF

cat > "$APP/Contents/MacOS/oneterm" <<LAUNCH_EOF
#!/bin/bash
# Make sure the host is up before opening a window at it. launchd normally has
# it running already; this covers the case where it was booted out by hand.
PORT=$PORT
for i in 1 2 3 4 5 6 7 8 9 10; do
  curl -sf --max-time 1 "http://127.0.0.1:\$PORT/health" >/dev/null && break
  launchctl kickstart "gui/\$UID/$LABEL" 2>/dev/null || true
  sleep 0.4
done
# Open in the REAL browser, as a normal tab in the Chrome you already have
# running — not a chrome-less --app window.
exec open -a "Google Chrome" "http://localhost:\$PORT"
LAUNCH_EOF
chmod +x "$APP/Contents/MacOS/oneterm"
cp "$DIR/assets/oneterm.icns" "$APP/Contents/Resources/oneterm.icns" 2>/dev/null
touch "$APP"                       # nudge Finder to re-read the bundle

# Register with LaunchServices or Spotlight will not index it, and `open -a`
# and Spotlight will both fail even though the bundle is perfectly valid.
LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
[ -x "$LSREG" ] && "$LSREG" -f "$APP" 2>/dev/null

# ── 3. the agent-state hook ─────────────────────────────────────────────────
# Claude Code publishes lifecycle events; without this, oneterm falls back to
# matching regexes against the pane, which is a guess about a UI nobody promised
# to keep stable. The installer merges into ~/.claude/settings.json rather than
# writing it, so another tool's hooks (herdr keeps one there) survive — and it
# refuses outright if it cannot parse the file. A failure here must NOT fail the
# whole install: the app still works, it just detects state the old way.
if "$NODE" "$DIR/bin/install-hooks.mjs"; then
  HOOKS_OK=1
else
  HOOKS_OK=0
  echo "  ! agent-state hook not installed — oneterm will fall back to pane matching"
fi

echo "installed:"
echo "  host   $PLIST  (launchd, KeepAlive)"
echo "  app    $APP"
echo "  logs   $LOG/host.log"
[ "$HOOKS_OK" = "1" ] && echo "  hooks  ~/.claude/hooks/oneterm-agent-state.sh (SessionStart, UserPromptSubmit, Stop)"
echo
echo "Launch it from Spotlight (\u2318Space -> oneterm), the Dock, or Finder > Applications."
echo "No terminal needed; the host also starts automatically at login."
