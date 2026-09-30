/* Getting a selection OUT of a pane.
 *
 * tmux holds the mouse in every oneterm session, so a drag is tmux's, not the
 * browser's: it copies into a tmux paste buffer that nothing outside tmux can
 * read, and the highlight cancels itself on mouse-up. The only thing that
 * carries those bytes back to the page is OSC 52, which tmux emits ONLY when
 * set-clipboard is on. Silent when it breaks — dragging just quietly does
 * nothing — so it is worth a test that watches the actual wire.
 *   node test/clipboard.test.mjs
 */
import pty from 'node-pty'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const TMUX = execFileSync('bash', ['-lc', 'command -v tmux'], { encoding: 'utf8' }).trim()
const SOCK = `oneterm-clip-${process.pid}`
const tmux = (...a) => execFileSync(TMUX, ['-L', SOCK, ...a], { encoding: 'utf8' }).trim()

let pass = 0, fail = 0
const ok  = m => { console.log(`  \x1b[32m✓\x1b[0m ${m}`); pass++ }
const bad = m => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); fail++ }
const sleep = ms => new Promise(r => setTimeout(r, ms))

console.log('\noneterm clipboard (OSC 52)\n')

// The host must ask for it in both places, or a session born before the change
// never gets it and one born after silently loses it on the next refactor.
const src = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
src.includes("'set-option', '-t', name, 'set-clipboard', 'on'")
  ? ok('createSession turns set-clipboard on') : bad('createSession turns set-clipboard on')
src.includes("'set-option', '-s', 'set-clipboard', 'on'")
  ? ok('the boot stamp turns it on for servers already up') : bad('the boot stamp turns it on for servers already up')

const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
page.includes('registerOscHandler(52')
  ? ok('the page registers an OSC 52 handler') : bad('the page registers an OSC 52 handler')
page.includes('macOptionClickForcesSelection:true')
  ? ok('Option+drag can force a real xterm selection') : bad('Option+drag can force a real xterm selection')
/* A reply to the '?' form hands whatever is on the clipboard to anything
   running in the pane. It must be swallowed, never answered. */
page.includes("b64 === '?'")
  ? ok('clipboard READ requests are refused') : bad('clipboard READ requests are refused')

// ── and now the wire, with a real client on a real pty ─────────────────────
/* Through the path a DRAG takes: copy-mode -> select -> copy-selection, which
   is what MouseDragEnd1Pane runs. `set-buffer -w` looks like a shortcut but is
   not one — it asks for the clipboard explicitly and so fires whatever
   set-clipboard says, which makes it useless for proving the option matters. */
let term
try {
  const MARKER = 'MARKER-┌─┐-END'
  tmux('new-session', '-d', '-s', 'c', `printf '%s\\n' '${MARKER}'; sleep 30`)
  tmux('set-option', '-t', 'c', 'mouse', 'on')

  const seen = []
  term = pty.spawn(TMUX, ['-L', SOCK, '-u', 'attach-session', '-t', 'c'], {
    name: 'xterm-256color', cols: 80, rows: 24,
    env: { ...process.env, TERM: 'xterm-256color', LANG: 'en_US.UTF-8' },
  })
  term.onData(d => seen.push(d))
  await sleep(700)

  const grab = () => { const s = seen.join(''); seen.length = 0; return s }
  const dragCopy = async () => {
    grab()
    tmux('copy-mode', '-t', 'c')
    tmux('send-keys', '-t', 'c', '-X', 'cursor-up')
    tmux('send-keys', '-t', 'c', '-X', 'select-line')
    tmux('send-keys', '-t', 'c', '-X', 'copy-selection-and-cancel')
    await sleep(400)
    return grab()
  }

  tmux('set-option', '-s', 'set-clipboard', 'off')
  ;(await dragCopy()).includes('\x1b]52;')
    ? bad('with set-clipboard off, OSC 52 arrives anyway (test is not discriminating)')
    : ok('with set-clipboard off, a drag-copy reaches the client as nothing at all')
  tmux('list-buffers').includes(MARKER)
    ? ok('…while the text sits in a tmux buffer nobody can read — the bug')
    : bad('the copy did not happen at all (test is broken, not the code)')

  tmux('set-option', '-s', 'set-clipboard', 'on')
  const out = await dragCopy()
  const m = out.match(/\x1b\]52;[^;]*;([A-Za-z0-9+/=]+)/)
  m ? ok('with set-clipboard on, the same drag-copy emits OSC 52')
    : bad('with set-clipboard on, the same drag-copy emits OSC 52')
  if (m) {
    /* The page decodes base64 -> bytes -> UTF-8. Do the same here: reading
       those bytes as latin-1 instead is exactly the mojibake that turns
       "┌" into "‚îå". */
    const decoded = new TextDecoder().decode(Uint8Array.from(Buffer.from(m[1], 'base64')))
    decoded.includes(MARKER)
      ? ok('the bytes survive base64 and a UTF-8 decode intact')
      : bad(`payload corrupted: ${JSON.stringify(decoded.slice(0, 60))}`)
  }
} finally {
  try { term?.kill() } catch {}
  try { tmux('kill-server') } catch {}
}

console.log(`\n─────────────────────────────\n  ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
