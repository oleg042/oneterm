/**
 * oneterm — your terminal, in the browser, in one window.
 *
 *   Browser (xterm.js) <--WebSocket--> this host <--PTY--> tmux <-- claude / zsh
 *
 * THE STABILITY DECISION: this host owns nothing.
 *
 * Every session is a tmux session. The host only attaches a PTY to tmux and
 * pumps bytes. So the host can crash, be OOM-killed, be restarted by launchd,
 * or be replaced by a new version mid-session — and your work is untouched,
 * because tmux is still holding it. Reattach and tmux repaints.
 *
 * That also makes tmux the single source of truth for "what sessions exist".
 * There is no in-memory session table to drift, and no localStorage list that
 * can disagree with reality. `tmux ls` IS the list.
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { WebSocketServer } from 'ws'
import pty from 'node-pty'

const execFileP = promisify(execFile)
const ROOT = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 7331)
const PREFIX = 'oneterm_'

/* launchd gives us a bare PATH, so never rely on it — resolve real paths once. */
const TMUX = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux']
  .find(p => existsSync(p)) ?? 'tmux'
const SHELL = process.env.SHELL || '/bin/zsh'

/** Run a command through a LOGIN shell so the user's real PATH applies. */
const loginShell = (cmd) => [SHELL, '-l', '-c', cmd]

async function tmux(args) {
  try { return (await execFileP(TMUX, args)).stdout } catch (e) { return e.stdout ?? '' }
}

/* ── session registry: tmux is the database ───────────────────────────────── */

/** Metadata rides along as tmux user-options (@oneterm_*), so it survives us. */
async function listSessions() {
  // NOT tab-separated: tmux's format parser eats literal tabs, which silently
  // collapsed every field into the session id and made every attach fail with
  // "session is gone". Any non-whitespace delimiter works; this one won't
  // appear in a label or a path.
  const D = '|~|'
  const fmt = ['#{session_name}', '#{session_created}', '#{session_attached}',
               '#{@oneterm_label}', '#{@oneterm_cwd}', '#{@oneterm_cmd}',
               '#{@oneterm_skip}', '#{@oneterm_order}',
               '#{pane_current_path}', '#{pane_current_command}',
               '#{session_activity}'].join(D)
  const out = await tmux(['list-sessions', '-F', fmt])
  return out.split('\n').filter(l => l.startsWith(PREFIX)).map(line => {
    const [name, created, attached, label, cwd, cmd, skip, order,
           livePath, liveCmd, activity] = line.split(D)
    return { id: name.slice(PREFIX.length), name,
             created: Number(created) * 1000, attached: attached !== '0',
             label: label || name, cmd: cmd || 'shell',
             skip: skip === '1',
             order: order === '' || order === undefined ? null : Number(order),
             // THE path. A login shell can cd away from tmux's -c, so the
             // requested cwd is a wish and pane_current_path is the fact.
             // Showing the wish is how `rm -rf build/` hits the wrong tree.
             cwd: livePath || cwd || '',
             requested: cwd || '',
             running: liveCmd || '',
             // seconds since this pane last produced output — the signal that
             // says "working" for sessions nothing is attached to
             idleFor: activity ? Math.max(0, Math.round(Date.now()/1000 - Number(activity))) : null }
  }).sort((a, b) => {
    // explicit drag order first; anything never dragged falls back to age
    const ao = a.order, bo = b.order
    if (ao !== null && bo !== null) return ao - bo
    if (ao !== null) return -1
    if (bo !== null) return 1
    return a.created - b.created
  })
}


/* A multi-session cockpit has to distinguish "working" from "blocked on YOU".
 * tmux can hand us the tail of each pane cheaply, so detect the shapes Claude
 * Code actually uses when it is waiting on a human decision. Without this a
 * blocked agent and an idle shell look identical, which defeats the point of
 * running four at once. */
const WAITING = [
  /Do you want (to|me)/i,
  /Enter to confirm/i,
  /\(y\/n\)/i,
  /Press Enter to/i,
  /❯\s*\d+\.\s/,          // Claude Code's numbered choice list
  /New MCP server found/i,
  /\bProceed\?/i,
]
/* Deliberately NOT matched: "N MCP servers need authentication". That is a
 * BANNER printed once at startup and it lives in the scrollback forever, so
 * matching it pinned a session to "needs you" for its whole life — including
 * while it was visibly working. Only the LAST few lines are a live prompt. */
async function paneTail(name) {
  /* The VISIBLE pane only — no -S, so no scrollback. Both signals we look for
   * describe the current frame: a run marker that is on screen now, or a prompt
   * awaiting an answer now. Reading history meant a marker from an old, long
   * finished turn kept a session pinned to "working". */
  const out = await tmux(['capture-pane', '-p', '-t', name])
  return out.replace(/\s+$/, '').slice(-2000)
}
/* Claude Code redraws its input box and status line constantly — a ticking
 * context %, a blinking cursor — so "the pane changed since last poll" is true
 * forever and a session stuck on "working". Detect the POSITIVE markers it
 * prints only while a turn is running instead. */
const WORKING = [
  /esc to interrupt/i,        // shown for the whole duration of a run
  /\(\d+s\s*[·)]/,             // the live elapsed timer, e.g. "(7s ·"
  /[✻✳✢✽✺✹]\s+\S+…/,          // spinner glyph + word + ellipsis
]
const lastTail = new Map()
/* Attaching or resizing a pane makes tmux REFLOW its contents, which changes
 * the captured text without a single byte of new output. The tail-diff can't
 * tell that apart from real work, so a session flashed "working" the moment you
 * clicked it. Suppress the signal briefly and re-baseline instead. */
const settleUntil = new Map()
function settle(name, ms = 1800) {
  settleUntil.set(name, Date.now() + ms)
  lastTail.delete(name)          // next capture becomes the new baseline
}
async function annotateWaiting(list) {
  await Promise.all(list.map(async (s) => {
    try {
      const tail = await paneTail(s.name)
      s.waiting = WAITING.some(re => re.test(tail))
      /* "Working" = the pane CHANGED since the last poll. tmux's
       * #{session_activity} does not reliably tick for a detached session, so a
       * busy agent read as idle. Comparing the pane tail is independent of
       * tmux's bookkeeping and true whether or not anyone is attached. */
      const settling = Date.now() < (settleUntil.get(s.name) ?? 0)
      if (s.cmd === 'claude') {
        s.working = WORKING.some(re => re.test(tail))
      } else {
        // a plain shell has no such marker, so fall back to "output changed"
        const prev = lastTail.get(s.name)
        lastTail.set(s.name, tail)
        s.working = !settling && prev !== undefined && prev !== tail
      }
      if (s.working) s.waiting = false      // actively printing is never "needs you"
    } catch { s.waiting = false; s.working = false }
  }))
  return list
}

async function createSession({ id, cmd, cwd, cols, rows, skip }) {
  const name = PREFIX + id
  const inner = cmd === 'claude'
    ? (skip ? 'claude --dangerously-skip-permissions' : 'claude')
    : `exec ${SHELL} -l`
  // -d: create detached, so creation never depends on a client being ready.
  // -e: the inner shell inherits the HOST's environment, not the attach
  //     client's — so ONETERM_* set at attach time never reached the shell.
  //     Stamp them at birth so scripts and hooks inside can tell where they are.
  await tmux(['-u', 'new-session', '-d', '-s', name, '-c', cwd,
              '-e', 'ONETERM=1', '-e', `ONETERM_SESSION=${id}`,
              '-x', String(cols || 120), '-y', String(rows || 32),
              ...loginShell(inner)])
  const label = cwd.split('/').filter(Boolean).pop() || '~'
  await tmux(['set-option', '-t', name, '@oneterm_label', label])
  await tmux(['set-option', '-t', name, '@oneterm_cwd', cwd])
  await tmux(['set-option', '-t', name, '@oneterm_cmd', cmd])
  // shells have no such flag — never stamp a session with a badge that lies
  await tmux(['set-option', '-t', name, '@oneterm_skip',
              (skip && cmd === 'claude') ? '1' : '0'])
  await tmux(['set-option', '-t', name, '@oneterm_order', String(Date.now() % 100000)])
  // Let the pane use the full client size rather than the smallest ever attached.
  await tmux(['set-option', '-t', name, 'window-size', 'latest'])
  await tmux(['set-option', '-t', name, 'status', 'off'])   // no tmux bar; our UI is the chrome
  await tmux(['set-option', '-t', name, 'mouse', 'on'])
  await tmux(['set-option', '-t', name, 'history-limit', '50000'])
  return name
}

/* ── skills + projects: what the ⌘K palette searches ──────────────────────── */

const HOME = process.env.HOME
async function readSkills() {
  // ~/.claude/skills/<name>/SKILL.md, plugin skills, and project-local ones.
  const roots = [join(HOME, '.claude/skills'), join(HOME, '.claude/plugins')]
  const out = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    const found = await tmuxlessFind(root, 'SKILL.md')
    for (const f of found) {
      try {
        const txt = await readFile(f, 'utf8')
        const meta = parseFrontmatter(txt)
        if (meta.name) out.push({ name: meta.name, desc: meta.description || '', path: f })
      } catch {}
    }
  }
  // ...and commands/*.md, which is where /commit, /code-review etc. actually
  // live. Indexing only SKILL.md hid the most-typed slash commands entirely.
  for (const root of [join(HOME, '.claude/commands'), join(HOME, '.claude/plugins')]) {
    if (!existsSync(root)) continue
    for (const f of await findMd(root)) {
      if (!/\/commands\//.test(f)) continue
      try {
        const txt = await readFile(f, 'utf8')
        const meta = parseFrontmatter(txt)
        const name = f.split('/').pop().replace(/\.md$/, '')
        const desc = meta.description
          || txt.replace(/^---[\s\S]*?---/, '').trim().split('\n')[0].replace(/^#+\s*/, '')
        out.push({ name, desc: (desc || '').slice(0, 160), path: f, kind: 'command' })
      } catch {}
    }
  }
  const seen = new Set()
  return out.filter(s => !seen.has(s.name) && seen.add(s.name))
            .sort((a, b) => a.name.localeCompare(b.name))
}

async function findMd(root) {
  try {
    const { stdout } = await execFileP('find', [root, '-name', '*.md', '-maxdepth', '6'],
                                       { maxBuffer: 8e6 })
    return stdout.split('\n').filter(Boolean)
  } catch { return [] }
}


/** Minimal YAML front-matter reader — handles plain scalars AND the `>` / `|`
 *  block forms, which several shipped skills use and a one-line regex reads
 *  as the literal string ">". */
function parseFrontmatter(txt){
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(txt)
  if (!m) return {}
  const lines = m[1].split(/\r?\n/)
  const out = {}
  for (let i = 0; i < lines.length; i++){
    const kv = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(lines[i])
    if (!kv) continue
    const [, key] = kv
    let val = kv[2].trim()
    if (val === '>' || val === '|' || val === '>-' || val === '|-' || val === ''){
      const buf = []
      while (i + 1 < lines.length && /^[ \t]+\S/.test(lines[i + 1])) buf.push(lines[++i].trim())
      val = buf.join(' ')
    }
    out[key] = val.replace(/^["']|["']$/g, '').trim()
  }
  return out
}

async function tmuxlessFind(root, filename) {
  try {
    const { stdout } = await execFileP('find', [root, '-name', filename, '-maxdepth', '6'],
                                       { maxBuffer: 4e6 })
    return stdout.split('\n').filter(Boolean)
  } catch { return [] }
}

async function readProjects() {
  const base = join(HOME, 'Projects')
  try {
    const { stdout } = await execFileP('find', [base, '-maxdepth', '1', '-type', 'd'])
    return stdout.split('\n').filter(p => p && p !== base)
      .map(p => ({ path: p, name: p.split('/').pop() }))
      .filter(p => !p.name.startsWith('.'))          // .claude, .playwright-mcp, ...
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch { return [] }
}

/* ── http ─────────────────────────────────────────────────────────────────── */

const VENDOR = {
  '/vendor/xterm.js':        '@xterm/xterm/lib/xterm.js',
  '/vendor/xterm.css':       '@xterm/xterm/css/xterm.css',
  '/vendor/addon-fit.js':    '@xterm/addon-fit/lib/addon-fit.js',
  '/vendor/addon-webgl.js':  '@xterm/addon-webgl/lib/addon-webgl.js',
  '/vendor/addon-search.js': '@xterm/addon-search/lib/addon-search.js',
}
const TYPES = { '.html':'text/html', '.css':'text/css', '.js':'text/javascript',
                '.json':'application/json', '.png':'image/png', '.svg':'image/svg+xml' }

const json = (res, body) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const server = createServer(async (req, res) => {
  try { await route(req, res) }
  catch (e) {
    // An async route that throws becomes an unhandled rejection, and node exits
    // on those by default. That is the classic "the localhost server just died"
    // — one malformed request, gone. Contain it here instead.
    console.error('[route error]', req.url, e?.message)
    if (!res.headersSent) res.writeHead(500, {'content-type':'application/json'})
    res.end(JSON.stringify({ error: String(e?.message ?? e) }))
  }
})

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const p = url.pathname

  if (p === '/health')   return json(res, { ok: true, tmux: TMUX, pid: process.pid })
  if (p === '/sessions') return json(res, await annotateWaiting(await listSessions()))
  if (p === '/skills')   return json(res, await readSkills())
  if (p === '/projects') return json(res, await readProjects())

  if (p === '/reorder') {
    const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean)
    for (let i = 0; i < ids.length; i++)
      await tmux(['set-option', '-t', PREFIX + ids[i], '@oneterm_order', String(i * 10)])
    return json(res, { ok: true })
  }
  if (p === '/rename') {
    const id = url.searchParams.get('id'), label = (url.searchParams.get('label') || '').slice(0, 60)
    if (id && label) await tmux(['set-option', '-t', PREFIX + id, '@oneterm_label', label])
    return json(res, { ok: true })
  }
  if (p === '/kill' && url.searchParams.get('id')) {
    await tmux(['kill-session', '-t', PREFIX + url.searchParams.get('id')])
    return json(res, { ok: true })
  }
  if (p === '/new') {
    const q = url.searchParams
    const id = 's' + Date.now().toString(36)
    await createSession({ id, cmd: q.get('cmd') || 'shell',
      cwd: q.get('cwd') || HOME, cols: Number(q.get('cols')), rows: Number(q.get('rows')),
      skip: q.get('skip') === '1' })
    return json(res, { id })
  }

  const file = VENDOR[p] ? join(ROOT, 'node_modules', VENDOR[p])
                         : join(ROOT, 'public', (p === '/' ? 'index.html' : p).replace(/^\/+/, ''))
  try {
    const body = await readFile(file)
    const ext = file.slice(file.lastIndexOf('.'))
    // The app shell must never be cached: without this Chrome kept serving a
    // stale index.html, so fixes appeared not to land at all. Vendor files are
    // versioned by package and can cache.
    const headers = { 'content-type': TYPES[ext] ?? 'text/plain' }
    if (!p.startsWith('/vendor/')) headers['cache-control'] = 'no-store, must-revalidate'
    res.writeHead(200, headers)
    res.end(body)
  } catch { res.writeHead(404).end('not found') }
}

/* ── websocket: a thin pipe between one browser pane and one tmux session ─── */

const wss = new WebSocketServer({ server, path: '/pty' })

wss.on('connection', async (ws, req) => {
  const q = new URL(req.url, 'http://x').searchParams
  const id = q.get('id')
  const cols = Number(q.get('cols')) || 120
  const rows = Number(q.get('rows')) || 32
  if (!id) { ws.close(); return }

  const name = PREFIX + id
  const sessions = await listSessions()
  if (!sessions.some(s => s.id === id)) {
    ws.send(`\r\n\x1b[31m[session ${id} is gone]\x1b[0m\r\n`); ws.close(); return
  }

  // NEVER attach with -d. It force-detaches every other client, so two open
  // viewers (a second tab, a second person) knock each other off in turn and
  // each auto-reconnects — an infinite reattach war that reads as the whole
  // screen strobing. Without -d they simply mirror, and `window-size latest`
  // (set at creation) means the most recent client decides the pane size.
  let term
  try {
    term = pty.spawn(TMUX, ['-u', 'attach-session', '-t', name], {
      name: 'xterm-256color', cols, rows, cwd: HOME,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor',
             LANG: process.env.LANG || 'en_US.UTF-8',
             LC_ALL: process.env.LC_ALL || 'en_US.UTF-8',
             // 15;0 = light bg, 0;15 = dark bg. Apps that respect COLORFGBG
             // pick a readable palette themselves rather than being overridden.
             COLORFGBG: q.get('light') === '1' ? '0;15' : '15;0',
             ONETERM: '1', ONETERM_SESSION: id },
    })
  } catch (e) {
    ws.send(`\r\n\x1b[31m[attach failed: ${e.message}]\x1b[0m\r\n`); ws.close(); return
  }
  settle(name)
  console.log(`[attach] ${name} ${cols}x${rows}`)

  term.onData(d => { if (ws.readyState === 1) ws.send(d) })
  term.onExit(() => { if (ws.readyState === 1) ws.close() })

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw.toString()) } catch { return }
    if (m.t === 'in') term.write(m.d)
    else if (m.t === 'resize') {
      try { term.resize(Math.max(2, m.cols|0), Math.max(1, m.rows|0)) } catch {}
      settle(name)               // a resize reflows the pane; that is not work
    }
  })
  // Detaching the PTY client leaves tmux — and everything in it — running.
  ws.on('close', () => { try { term.kill() } catch {} ; console.log(`[detach] ${name}`) })
})

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    // Someone is already serving this port — almost always another copy of us.
    // Exiting 0 is correct and, with KeepAlive{SuccessfulExit:false}, launchd
    // leaves it alone instead of crash-looping on a stack trace.
    console.log(`port ${PORT} already in use — assuming another oneterm host; exiting quietly`)
    process.exit(0)
  }
  console.error('fatal:', e)
  process.exit(1)
})
process.on('SIGTERM', () => process.exit(0))
process.on('uncaughtException', (e) => {
  console.error('[uncaught]', e?.stack ?? e)
  process.exit(1)          // launchd restarts us; tmux kept the work
})
process.on('unhandledRejection', (e) => {
  console.error('[unhandled rejection]', e?.stack ?? e)
  process.exit(1)
})

server.listen(PORT, '127.0.0.1', () =>
  console.log(`oneterm → http://localhost:${PORT}  (tmux: ${TMUX})`))
