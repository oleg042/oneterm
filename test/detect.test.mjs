#!/usr/bin/env node
/* Runs the SHIPPING detection patterns against panes captured from live
 * sessions.  node test/detect.test.mjs
 *
 * Why this exists: every detection bug in this project had the same shape — an
 * assumption about where Claude Code draws something, never checked against a
 * real pane. "The status line is always at the bottom" was wrong (the agent
 * panel goes below it). "A timer means a turn is running" was wrong (finished
 * steps and the /goal badge print timers too). Both shipped, both were caught
 * by the operator rather than by me.
 *
 * So: capture real panes, write down what a human reading them says the state
 * is, and hold the patterns to it. It imports ../detect.mjs directly, so it can
 * never drift from what the server actually runs. */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { classify, liveTail, LIVE_LINES, paneWindow, processTable, isInteractiveClaude,
         runsClaude } from '../detect.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const expected = JSON.parse(readFileSync(join(HERE, 'expected.json'), 'utf8'))
let pass = 0, fail = 0
const ok  = m => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${m}`) }
const bad = m => { fail++; console.log(`  \x1b[31m✗\x1b[0m ${m}`) }
const is  = (got, want, m) => got === want ? ok(m) : bad(`${m} — expected ${want}, got ${got}`)

/* ── 1. real captured panes ─────────────────────────────────────────────── */
console.log('\n1. real panes, against a human reading of each')
const dir = join(HERE, 'fixtures')
const files = readdirSync(dir).filter(f => f.endsWith('.pane')).sort()
if (!files.length) bad('no fixtures — run scratchpad/collect.py')

for (const f of files) {
  const exp = expected[f]
  if (!exp) { bad(`${f}: no expectation recorded — add one to expected.json`); continue }
  // exactly what server.mjs feeds it
  const tail = paneWindow(readFileSync(join(dir, f), 'utf8'))
  const got = classify(tail, 'claude')
  const diff = ['working', 'fg', 'bg', 'waiting'].filter(k => got[k] !== exp[k])
  if (diff.length)
    bad(`${f}\n      expected ${diff.map(k => `${k}=${exp[k]}`).join(' ')}` +
        `\n      got      ${diff.map(k => `${k}=${got[k]}`).join(' ')}` +
        `\n      ${exp.why}`)
  else ok(`${f.replace(/_[0-9a-f]{6}\.pane$|\.pane$/, '')}  (${got.why.slice(0, 34)})`)
}

/* ── 2. shapes that must NOT be read as work ────────────────────────────── */
/* Each of these was a real false positive that reached the operator as a
 * wrong dot or a chime on a session that had not finished. */
console.log('\n2. text that must never count as working')
const mustNotWork = [
  ['⏺ Baked for 3m 12s · done 11:03 PM · 1 shell still running', 'transcript prose naming a shell'],
  ['                              ◎ /goal active (41m)',         'the /goal badge — pinned a session busy 41 min'],
  ['⏺ Agent "UX gate" finished · 4m 57s',                        'a finished agent'],
  ['⏺ Cogitated for 4m 31s · done 11:14 PM',                     'a finished step'],
  ['  ⎿  Backgrounded agent (↓ to manage · ctrl+o to expand)',   'a paren that is not a timer'],
  ['  Ran 4 shell commands',                                     'the word shell with no status segment'],
  ['⏺ Something rather interesting…',                            'a sentence that happens to end in an ellipsis'],
  ['  ⏵⏵ auto mode on · ← 7 agents',                             'agents alone are NOT a working signal'],
  ['  I am waiting for 2 reviewers to finish the pass.',         'prose about waiting, mid-sentence'],
  ['⏺ Waiting for the build and the tests to finish',            'waiting with no count is prose, not status'],
  ['⏺ Compacting conversation history is what /compact does…',   'the compaction phrase inside a sentence'],
  ['  Retrying in 5s did not help, so I stopped.',                'prose about retrying, no attempt counter'],
  ['⏺ Waiting for API response was slow earlier',                'the stall phrase with no retry suffix'],
]
for (const [line, note] of mustNotWork) {
  const c = classify(line, 'claude')
  c.working ? bad(`matched "${line.trim().slice(0, 46)}" — ${note} (via ${c.why})`)
            : ok(`ignored: ${note}`)
}

/* ── 3. shapes that MUST be read as work ────────────────────────────────── */
console.log('\n3. text that must always count as working')
const mustWork = [
  ['✽ Ideating… (5m 42s · ↓ 20.1k tokens)',        'fg', 'spinner with a timer'],
  ['✳ Ideating…',                                   'fg', 'spinner before a timer appears'],
  ['  ⏵⏵ auto mode on · 2 shells · 1 feedback draft','bg', 'background shells, main loop idle'],
  ['  ⏵⏵ auto mode on · 1 shell',                   'bg', 'shells segment ending the line'],
  ['✻ Waiting for 1 background agent to finish',    'bg', 'handed off to a background agent'],
  ['✻ Waiting for 1 background agent and 1 dynamic workflow to finish', 'bg', 'an agent AND a workflow — read as idle'],
  ['✻ Waiting for 1 dynamic workflow to finish',    'bg', 'a workflow on its own'],
  ['✻ Waiting for 2 background agents, 1 dynamic workflow and 1 shell to finish', 'bg', 'a longer list'],
  ['… press esc to interrupt',                      'fg', 'the interrupt hint'],
  /* 2026-10-14: each of these drew a blank pane for a live turn, and after 60s
     the stale-hook fallback believed the blank and rang "done" mid-run. */
  ['✻ Compacting conversation… (1m 34s · ↓ 1.2k tokens)', 'fg', 'auto-compaction, 64-166s long'],
  ['✻ Compacting conversation…',                    'fg', 'compaction before its timer appears'],
  ['✻ Running PreCompact hooks…',                   'fg', 'the hook phase around a compaction'],
  ["✶ Beboppin'… (3m 1s · ↓ 5k tokens)",            'fg', 'a verb with an apostrophe'],
  ['✶ Flambéing…',                                  'fg', 'a verb with an accent'],
  ['· Sautéing… (12s · ↓ 3k tokens)',               'fg', 'the other accented verb'],
  ['⚠ Waiting for API response · will retry in 5s · check your network', 'fg', 'the 20s stall banner'],
  ['⚠ No response from the API after 25s · retrying, waiting up to 1m · attempt 2/10', 'fg', 'no first byte'],
  ['⚠ API Error (529 overloaded) · Retrying in 5s · attempt 3/10', 'fg', 'an error being retried'],
]
for (const [line, kind, note] of mustWork) {
  const c = classify(line, 'claude')
  c.working && c[kind] ? ok(`${note} → ${kind}`)
                       : bad(`"${line.trim().slice(0, 40)}" should be working/${kind}, got working=${c.working} fg=${c.fg} bg=${c.bg}`)
}

/* ── 4. a prompt behind background work is still blocked on you ─────────── */
console.log('\n4. a live prompt is not hidden by background work')
{
  const pane = ['❯ 1. Yes', '  2. No', '  ⏵⏵ auto mode on · 2 shells · 1 feedback draft'].join('\n')
  const c = classify(pane, 'claude')
  c.waiting && c.bg ? ok('prompt + background shell → waiting AND working')
                    : bad(`expected waiting+bg, got waiting=${c.waiting} bg=${c.bg} fg=${c.fg}`)
  const busy = classify(['❯ 1. Yes', '✽ Ideating… (2m 1s ·)'].join('\n'), 'claude')
  busy.waiting ? bad('a FOREGROUND turn must override a stale prompt')
               : ok('prompt + running turn → not waiting (foreground wins)')
}

/* ── 5. the window has to clear the agent panel ─────────────────────────── */
console.log('\n5. LIVE_LINES clears the expanded agent panel')
{
  const f = 'status4_spin0_shells1_prompt0_RECONSTRUCTED.pane'
  const tail = readFileSync(join(dir, f), 'utf8').replace(/\s+$/, '').slice(-2000)
  const lines = tail.split('\n')
  const at = lines.length - lines.findIndex(l => /·\s*[1-9]\d*\s+shells?\s*(?=·|$)/.test(l))
  at <= LIVE_LINES ? ok(`status line sits ${at} lines up, window is ${LIVE_LINES}`)
                   : bad(`status line ${at} lines up but LIVE_LINES is only ${LIVE_LINES}`)
  liveTail(tail, 3).includes('shells')
    ? bad('the 3-line window would have caught it — fixture is not reproducing the bug')
    : ok('a 3-line window still misses it — the fixture reproduces the original bug')
}

/* ── 6. which tabs are running Claude ───────────────────────────────────── */
/* The launch tag said "shell" for a claude typed by hand, so its own fullscreen
 * redraws were judged by the shell rule and scrolling rang "done". These are
 * the real process shapes from this machine (ps -axo pid=,ppid=,args=). */
console.log('\n6. kind from the process table, not the launch tag')
{
  const ps = [
    // wrapper-launched: zsh -c names claude in its ARGS only
    "  100     1 /bin/zsh -l -c claude --dangerously-skip-permissions; stty sane 2>/dev/null",
    "  101   100 claude --dangerously-skip-permissions",
    "  102   101 npm exec @playwright/mcp@latest",
    // typed by hand into the shell the wrapper left behind
    "  200     1 /bin/zsh -l",
    "  201   200 claude --name oneaway-app --resume 50ca3698-3fa0-4a83-b306-a60597746f77",
    // exec'd: the pane's own process IS claude
    "  300     1 claude --dangerously-skip-permissions",
    // a shell tab running a script that calls the model and exits
    "  400     1 /bin/zsh -l",
    "  401   400 python3 run.py",
    "  402   401 /Users/x/.local/bin/claude -p summarise this",
    // a plain shell whose command line merely mentions claude
    "  500     1 /bin/zsh -l",
    "  501   500 grep -r claude .",
    // invoked through the versions path
    "  600     1 /bin/zsh -l",
    "  601   600 /Users/x/.local/share/claude/versions/2.1.299",
  ].join('\n')
  const t = processTable(ps)
  is(runsClaude(100, t), true,  'wrapper-launched claude is found under the wrapper shell')
  is(runsClaude(200, t), true,  'THE REPORTED BUG: a claude typed by hand into an SH tab is found')
  is(runsClaude(300, t), true,  "a pane whose own process is claude")
  is(runsClaude(400, t), false, '`claude -p` from a script does not turn a shell tab into Claude')
  is(runsClaude(500, t), false, 'a command line merely mentioning claude does not either')
  is(runsClaude(600, t), true,  'claude run through its versions path')
  is(runsClaude(999, t), false, 'an unknown pane pid is not claude')
  is(isInteractiveClaude('/bin/zsh -l -c claude'), false, 'the wrapper shell itself is not claude')
  is(processTable('').args.size, 0, 'an empty ps read is an empty table (the host then skips, never demotes)')
}

console.log(`\n─────────────────────────────\n  ${pass} passed, ${fail} failed`)
console.log(fail ? '  detection is WRONG — do not ship\n' : '  detection matches every real pane.\n')
process.exit(fail ? 1 : 0)
