/* The pure half of branching a session: what the branch is called, which
 * conversation it forks, and where it lands in the rail. Kept out of server.mjs
 * for the same reason as detect.mjs and agentstate.mjs — the test has to run
 * the decision that ships, not a copy of it.
 *   node test/branch.test.mjs
 */
import { branchLabel, conversationIdFromTranscript, orderAfter, CONV_ID, BRANCH_MARK }
  from '../branch.mjs'

let pass = 0, fail = 0
const ok  = m => { console.log(`  \x1b[32m✓\x1b[0m ${m}`); pass++ }
const bad = m => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); fail++ }
const eq = (got, want, m) => JSON.stringify(got) === JSON.stringify(want)
  ? ok(m) : bad(`${m}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`)

console.log('\noneterm branching\n')

// ── labels ──────────────────────────────────────────────────────────────────
eq(BRANCH_MARK, '↳ ', 'the mark is an arrow every system font has')
eq(branchLabel('oneterm', ['oneterm']), '↳ oneterm', 'first branch takes the plain mark')
eq(branchLabel('oneterm', ['oneterm', '↳ oneterm']), '↳ oneterm 2', 'second branch is numbered')
eq(branchLabel('oneterm', ['oneterm', '↳ oneterm', '↳ oneterm 2']), '↳ oneterm 3', 'and the third')
eq(branchLabel('↳ oneterm', ['oneterm', '↳ oneterm']), '↳ oneterm 2',
   'a branch of a branch strips the mark instead of stacking it')
eq(branchLabel('↳ ↳ oneterm', []), '↳ oneterm', 'however many marks were stacked')
/* Review focus 4: numbering has to skip EVERY label in use, not just the
   parent's own branches — a tab you renamed yourself counts too. */
eq(branchLabel('api', ['api', 'unrelated', '↳ api']), '↳ api 2',
   'a label taken by any tab is skipped')
eq(branchLabel('', []), '↳ session', 'an empty label still yields a usable name')
eq(branchLabel(undefined, []), '↳ session', 'so does a missing one')
/* Review focus 4: the row format is delimiter-separated, so a label holding
   the delimiter makes listSessions drop the row — the branch would exist in
   tmux and never appear in the rail. And rename caps labels at 60. */
eq(branchLabel('a|~|b', []), '↳ a/b', 'the tmux row delimiter cannot survive into a label')
const long = 'x'.repeat(60)
const l1 = branchLabel(long, [])
l1.length <= 60 ? ok('a 60-char parent still yields a label within the cap')
                : bad(`label is ${l1.length} chars`)
const l2 = branchLabel(long, [l1])
l2.length <= 60 && l2 !== l1 && l2.endsWith(' 2')
  ? ok('…and so does its numbered sibling, with the number intact')
  : bad(`numbered long label: ${JSON.stringify(l2)}`)

// ── which conversation ──────────────────────────────────────────────────────
const U = '2979b8e9-3285-4dc0-9548-b1553aa5b2de'
eq(conversationIdFromTranscript(`/Users/x/.claude/projects/-a-b/${U}.jsonl`), U,
   'the id comes from the filename, which Claude Code names after the session')
eq(conversationIdFromTranscript(`/x/${U}.json`), null, 'only a .jsonl transcript counts')
eq(conversationIdFromTranscript('/x/$(rm -rf ~).jsonl'), null,
   'anything but the id shape is refused — it reaches a command line')
eq(conversationIdFromTranscript(''), null, 'empty is no conversation')
eq(conversationIdFromTranscript(undefined), null, 'missing is no conversation')
eq(conversationIdFromTranscript(42), null, 'a non-string is no conversation')
CONV_ID.test(U) && !CONV_ID.test('abc') && !CONV_ID.test(U + ';x')
  ? ok('CONV_ID accepts the shape Claude Code mints and nothing looser')
  : bad('CONV_ID shape')

// ── where it lands ──────────────────────────────────────────────────────────
eq(orderAfter(['a', 'p', 'b'], 'p', 'n'), ['a', 'p', 'n', 'b'], 'directly under its parent')
eq(orderAfter(['a', 'b', 'p'], 'p', 'n'), ['a', 'b', 'p', 'n'], 'parent at the bottom')
eq(orderAfter(['n', 'a', 'p', 'b'], 'p', 'n'), ['a', 'p', 'n', 'b'],
   'a branch already in the list (createSession put it on top) is moved, not duplicated')
eq(orderAfter(['a', 'b'], 'gone', 'n'), ['n', 'a', 'b'],
   'a parent that vanished meanwhile puts the branch on top, like any new tab')

console.log(`\n  ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
console.log('  branching decisions hold.\n')
