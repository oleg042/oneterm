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
import { classify, liveTail, LIVE_LINES, paneWindow } from '../detect.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const expected = JSON.parse(readFileSync(join(HERE, 'expected.json'), 'utf8'))
let pass = 0, fail = 0
const ok  = m => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${m}`) }
const bad = m => { fail++; console.log(`  \x1b[31m✗\x1b[0m ${m}`) }

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
  ['… press esc to interrupt',                      'fg', 'the interrupt hint'],
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

console.log(`\n─────────────────────────────\n  ${pass} passed, ${fail} failed`)
console.log(fail ? '  detection is WRONG — do not ship\n' : '  detection matches every real pane.\n')
process.exit(fail ? 1 : 0)
