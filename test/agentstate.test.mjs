#!/usr/bin/env node
/* The hook/pane state machine. Every case here is a bug that actually reached
 * the user, or the exact thing a reviewer said would.
 *   node test/agentstate.test.mjs */
import { hookWorking, applyEvent, decideWorking } from '../agentstate.mjs'

let pass = 0, fail = 0
const ok  = m => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${m}`) }
const bad = m => { fail++; console.log(`  \x1b[31m✗\x1b[0m ${m}`) }
const is  = (got, want, m) => got === want ? ok(m) : bad(`${m} — expected ${want}, got ${got}`)
const MS = 60_000
const decide = o => decideWorking({ missedStopMs: MS, ...o })

console.log('\n1. aggregation across agents in one tmux session')
{
  is(hookWorking(undefined), undefined, 'never heard from → undefined')
  is(hookWorking({ agents: {} }), undefined, 'a session event alone → still undefined')
  is(hookWorking({ agents: { a: { working: true } } }), true, 'one working agent → true')
  is(hookWorking({ agents: { a: { working: false } } }), false, 'one stopped agent → false')
  is(hookWorking({ agents: { a: { working: true }, b: { working: false } } }), true,
     'THE CLOBBER BUG: one agent stops while another runs → still working')
  is(hookWorking({ agents: { a: { working: false }, b: { working: false } } }), false,
     'all agents stopped → false')
}

console.log('\n1b. stale agents cannot pin a session busy')
{
  const HOUR = 3600_000, now = 10 * HOUR
  is(hookWorking({ agents: { dead: { working: true, at: now - 5 * HOUR } } }, now), undefined,
     'an agent that died 5h ago without a Stop is ignored entirely')
  is(hookWorking({ agents: { dead: { working: true, at: now - 5 * HOUR },
                             live: { working: false, at: now } } }, now), false,
     'a dead working bucket cannot outvote the live stopped one')
  is(hookWorking({ agents: { slow: { working: true, at: now - 40 * 60_000 } } }, now), true,
     'a genuinely long turn (40m, no events) is still trusted')

  // THE OBSERVED BUG: legacy '_' bucket + a real claude session
  const e = { agents: { _: { working: true, at: now } } }
  applyEvent(e, { action: 'stop', claudeSession: 'real-1' }, now)
  is(Object.keys(e.agents).join(','), 'real-1',
     "a real claude id retires the '_' bucket rather than living alongside it")
  is(hookWorking(e, now), false,
     'so a stop actually means stopped — this logged "stop working=1" in the wild')
}

console.log('\n2. folding events')
{
  const e = applyEvent(undefined, { action: 'session', claudeSession: 's1' }, 1000)
  is(hookWorking(e, 1000), undefined, 'SessionStart carries no working state')
  applyEvent(e, { action: 'start', claudeSession: 's1' }, 2000)
  is(hookWorking(e, 2000), true, 'start → working')
  applyEvent(e, { action: 'stop', claudeSession: 's1' }, 3000)
  is(hookWorking(e, 3000), false, 'stop → not working')

  // second claude in the same tmux session
  applyEvent(e, { action: 'start', claudeSession: 's2' }, 4000)
  is(hookWorking(e, 4000), true, 'a second agent starting revives the session')
  applyEvent(e, { action: 'stop', claudeSession: 's1' }, 5000)
  is(hookWorking(e, 5000), true, "the first agent stopping AGAIN cannot end the second's turn")
  applyEvent(e, { action: 'stop', claudeSession: 's2' }, 6000)
  is(hookWorking(e, 6000), false, 'both stopped → false')

  const noPy = applyEvent(undefined, { action: 'start' }, 1000)
  is(hookWorking(noPy, 1000), true, 'an event with no claudeSession (no python3) still counts')
}

console.log('\n3. THE REPORTED BUG — a turn that begins with no human prompt')
/* oneawaybuild ran visibly for nine minutes showing "Orchestrating… (11m 56s)"
   while the rail said idle, because its last event was Stop and Stop was being
   treated as authoritative. Auto mode and /goal start turns with no
   UserPromptSubmit, so no start event ever arrives. */
{
  const d = decide({ hook: false, paneWorking: true, regexWorking: true })
  is(d.working, true, 'hook says stopped but the pane shows a spinner → WORKING')
  is(d.from, 'regex', 'and the decision is credited to the pane, not the hook')
  is(d.why, 'pane — turn began with no prompt', 'the log says why')
}

console.log('\n4. what Stop is still good for')
{
  const d = decide({ hook: false, paneWorking: false, regexWorking: false })
  is(d.working, false, 'hook stopped + pane quiet → not working')
  is(d.why, 'hook:stopped', 'attributed to the hook')
}

console.log('\n5. hook says working')
{
  is(decide({ hook: true, paneWorking: true, regexWorking: true }).working, true,
     'both agree → working')
  is(decide({ hook: true, paneWorking: false, regexWorking: false }).working, true,
     'pane momentarily quiet mid-turn → still working (this is the sub-agent gap)')
  is(decide({ hook: true, paneWorking: false, regexWorking: false }).latched, false,
     'and no latch is applied, because an event needs no blink tolerance')
}

console.log('\n6. a Stop lost while the host was restarting')
{
  const t0 = 100_000
  const a = decide({ hook: true, paneWorking: false, regexWorking: false, quietSince: null, now: t0 })
  is(a.working, true, 'first quiet poll → still trusts the hook')
  is(a.quietSince, t0, 'and starts the clock')
  const b = decide({ hook: true, paneWorking: false, regexWorking: false, quietSince: t0, now: t0 + MS - 1 })
  is(b.working, true, 'just inside the window → still trusts it')
  const c = decide({ hook: true, paneWorking: false, regexWorking: false, quietSince: t0, now: t0 + MS + 1 })
  is(c.working, false, 'past the window → stops believing a start that never ended')
  is(c.from, 'regex', 'and hands the decision back to the pane')
}

console.log('\n7. no hook at all (a session predating the install)')
{
  is(decide({ hook: undefined, paneWorking: true, regexWorking: true }).working, true,
     'pure regex still works')
  is(decide({ hook: undefined, paneWorking: false, regexWorking: false }).working, false,
     'and still goes idle')
  is(decide({ hook: undefined, paneWorking: false, regexWorking: false }).from, 'regex',
     'credited to the pane')
}

console.log('\n8. the hook can never veto the pane (the invariant, exhaustively)')
{
  let violations = 0
  for (const hook of [true, false, undefined])
    for (const regexWorking of [true, false])
      for (const paneWorking of [true, false]) {
        const d = decide({ hook, paneWorking, regexWorking })
        // If the pane says a turn is running, the answer must never be "idle".
        if (regexWorking && !d.working) violations++
      }
  is(violations, 0, 'across all 12 combinations, a live pane is never reported idle')
}

console.log(`\n─────────────────────────────\n  ${pass} passed, ${fail} failed`)
console.log(fail ? '  state machine is WRONG — do not ship\n' : '  state machine holds.\n')
process.exit(fail ? 1 : 0)
