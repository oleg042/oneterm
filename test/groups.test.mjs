/* The pure half of branch groups: which tabs draw as a group, what colour a
 * new one gets, where a dragged tab can land, and what a drop does. The page
 * imports the same module from /groups.mjs, so this runs the decisions that
 * ship on BOTH sides — the host's and the drag's.
 *   node test/groups.test.mjs
 */
import { GROUP_ID, validGroup, groupColor, newGroupId, railItems, memberMap,
         liveGroupIds, branchGroup, dropLayout, locate, holdCheck, resolveDrop } from '../groups.mjs'

let pass = 0, fail = 0
const ok  = m => { console.log(`  \x1b[32m✓\x1b[0m ${m}`); pass++ }
const bad = m => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); fail++ }
const eq = (got, want, m) => JSON.stringify(got) === JSON.stringify(want)
  ? ok(m) : bad(`${m}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`)

const G = '0.aaaaaa01', H = '1.bbbbbb02'
const S = (id, group = null) => ({ id, group })
const L = (...xs) => xs.map(x => Array.isArray(x) ? S(...x) : S(x))
const shape = items => items.map(i => i.kind === 'tab' ? i.s.id : [i.id, i.members.map(s => s.id)])
const NOW = Date.UTC(2026, 9, 4), R0 = () => 0

console.log('\noneterm branch groups\n')

// ── ids and colours ─────────────────────────────────────────────────────────
validGroup(G) && validGroup('4.zzzzzz') && !validGroup('5.aaaaaa') && !validGroup('0.abc')
  && !validGroup('0.aaaaaa|~|x') && !validGroup(null) && !validGroup('')
  ? ok('GROUP_ID takes the minted shape and nothing looser — it reaches a tmux option')
  : bad('GROUP_ID shape')
eq([groupColor(G), groupColor(H), groupColor('junk')], [0, 1, null], 'the colour is the first digit')
eq(newGroupId([], NOW, R0)[0], '0', 'the first group takes colour 0')
eq(newGroupId([G, H], NOW, R0)[0], '2', 'a new group takes the least-used colour')
eq(newGroupId(['0.aaaaaa', '0.bbbbbb', '2.cccccc', '3.dddddd', '4.eeeeee'], NOW, R0)[0], '1',
   'ties go to the lowest index')
eq(newGroupId([G, G, G], NOW, R0)[0], '1', 'a group is counted once however many tabs carry it')
GROUP_ID.test(newGroupId([], NOW, Math.random)) && GROUP_ID.test(newGroupId([], 1000, R0))
  && GROUP_ID.test(newGroupId([], Date.now(), () => 0.9999))
  ? ok('a minted id always passes the validation the host applies')
  : bad(`minted ids: ${newGroupId([], NOW, Math.random)} ${newGroupId([], 1000, R0)}`)

// ── what draws as a group ───────────────────────────────────────────────────
eq(shape(railItems(L('a', 'b'))), ['a', 'b'], 'plain tabs stay plain')
eq(shape(railItems(L('a', ['b', G], ['c', G], 'd'))), ['a', [G, ['b', 'c']], 'd'],
   'a run of two with one id is a group')
eq(shape(railItems(L(['a', G], 'b'))), ['a', 'b'], 'a group of one draws as a plain tab')
eq(shape(railItems(L(['a', G], ['b', G], 'c', ['d', G], ['e', G]))),
   [[G, ['a', 'b']], 'c', [G, ['d', 'e']]], 'a split group draws as two runs instead of crashing')
eq(shape(railItems(L(['a', 'x|~|y'], ['b', 'x|~|y']))), ['a', 'b'], 'an invalid id is no group')
eq(railItems(L(['a', H], ['b', H]))[0].color, 1, 'a group carries its colour')
eq(shape(railItems(L(['m', G], ['n', G]))), [[G, ['m', 'n']]],
   'closing the top tab of a group leaves it the same group, colour and all')
eq([...memberMap(L('a', ['b', G], ['c', G], ['d', H])).entries()], [['b', G], ['c', G]],
   'memberMap lists drawn group members only')
eq(liveGroupIds(L(['a', G], ['b', G], ['c', H])), [G], 'a stale single id is not a live group')

// ── which group a branch lands in ───────────────────────────────────────────
const bgL = L('p', ['a', G], ['b', G])
const bg = branchGroup(bgL[0], bgL, NOW, R0)
bg.parentNeedsIt && GROUP_ID.test(bg.group) && bg.group[0] === '1'
  ? ok('branching a plain tab mints a new group for both, in a free colour')
  : bad(`branchGroup plain: ${JSON.stringify(bg)}`)
eq(branchGroup(bgL[1], bgL, NOW, R0), { group: G, parentNeedsIt: false },
   'branching a grouped tab joins its group')
const lone = L(['p', H], 'x')
eq(branchGroup(lone[0], lone, NOW, R0), { group: H, parentNeedsIt: false },
   'a tab left alone with its old id gets that group back when branched')
/* Review: a stray tab still carrying a LIVE group's id (an old page dragged
   it out without groups=) must not hand that id to its branch — the branch
   would sit in a second run of the group, a split group. */
const stray = L(['c', G], 'x', ['a', G], ['b', G])
const bs = branchGroup(stray[0], stray, NOW, R0)
bs.group !== G && bs.parentNeedsIt
  ? ok("a stray tab carrying a live group's id branches into a new group, not a split one")
  : bad(`stray branch: ${JSON.stringify(bs)}`)

// ── drop positions: the doorway ─────────────────────────────────────────────
const at = (lay, i) => [lay.positions[i].gap, lay.positions[i].group]
const L1 = L('x', ['h', G], ['m', G], ['n', G], 'y')
const lay1 = dropLayout(L1, 'n')
eq(at(lay1, lay1.origin), [3, G], 'a member starts inside its group')
const c1 = lay1.positions[lay1.origin].offset
eq(at(lay1, locate(lay1, c1 + 0.2)), [3, G], 'a short pull past the edge stays inside')
eq(at(lay1, locate(lay1, c1 + 0.5)), [3, null],
   'half a row past the bottom edge and it is out — the doorway')
eq(at(lay1, locate(lay1, c1 + 1.5)), [4, null], 'another row on and it is past y')

const L2 = L(['h', G], ['m', G], ['n', G], 'y')
const lay2 = dropLayout(L2, 'h')
eq(at(lay2, lay2.origin), [0, G], 'the head of a group at the very top starts inside')
eq(at(lay2, locate(lay2, lay2.positions[lay2.origin].offset - 0.5)), [0, null],
   'and leaves upward through the doorway even with nothing above it')

const L3 = L('p', ['h', G], ['m', G], 'y')
eq(dropLayout(L3, 'p').positions.map(p => [p.gap, p.group]),
   [[0, null], [0, G], [1, G], [2, G], [2, null], [3, null]],
   'a plain tab passing a group goes join-at-top, inside, join-at-bottom, out')

// ── where the pointer is: over a tab, judged on screen ──────────────────────
/* Rows 50px tall; the dragged tab 'a' starts at the top, its centre at 25. */
const P = L('a', 'b', 'c', 'd')
const play = dropLayout(P, 'a')                       // gap 0 sits above b
const rowAt = (r, top, holdable = true) => ({ r, top, bottom: top + 49, holdable })
const nextFor = mid => locate(play, play.positions[play.origin].offset + (mid - 25) / 50)
/* Review of real use: dragged SQUARELY onto b — centre on b's centre — used to
   read as "past b" and slide b away. It must be over b, gap unmoved. */
eq(holdCheck(play, play.origin, nextFor(75), 75, null, rowAt(0, 50)), { pos: play.origin, over: 0 },
   'a tab dragged squarely onto the next one is over it, and that one holds still')
eq(holdCheck(play, play.origin, nextFor(54), 54, null, rowAt(0, 50)), { pos: play.origin, over: null },
   'short of its middle the tab does not slide away yet — it waits to be landed on')
eq(play.positions[holdCheck(play, play.origin, nextFor(95), 95, null, rowAt(0, 50)).pos].gap, 1,
   'past its middle the gap moves on: an ordinary reorder')
/* Real use, again: the middle half of a row was too small a target to find.
   Most of the tab counts now — just in from either edge is already over it. */
eq(holdCheck(play, play.origin, nextFor(59), 59, null, rowAt(0, 50)).over, 0,
   'just in from the top edge of the next tab is already over it')
eq(holdCheck(play, play.origin, nextFor(90), 90, null, rowAt(0, 50)).over, 0,
   'and so is just short of its bottom edge')
const prevRow = { r: 0, top: 0, bottom: 49, holdable: true }
const up = dropLayout(L('a', 'b', 'c'), 'b')               // 'b' dragged up onto 'a'
eq(holdCheck(up, up.origin, locate(up, up.positions[up.origin].offset - 0.8), 10, prevRow, null).over, 0,
   'dragged up, the tab above is a target just as big')
eq(holdCheck(play, play.origin, nextFor(75), 75, null, rowAt(0, 50, false)).over, null,
   'a tab it cannot group with (already in its group) is never "over"')
eq(play.positions[holdCheck(play, play.origin, nextFor(80), 80, null, rowAt(0, 50, false)).pos].gap, 1,
   '…and reorders past it as it always did')
/* A fast flick: the pointer is sampled about once a frame, and travel jumps
   several rows at once — the gap must go with it. */
const far = nextFor(25 + 4 * 50)
eq(play.positions[holdCheck(play, play.origin, far, 225, null, rowAt(0, 50)).pos].gap, 3,
   'a fast flick far past the next tab carries the gap along')
/* Doorway check: travel units charge half a row at a group edge, so they
   cannot be what decides "over" — here travel alone would already have
   crossed the head of the group while the eye is still lining up on it. */
const PD = L('p', ['h', G], ['m', G], 'y')
const pdl = dropLayout(PD, 'p')
const pnext = locate(pdl, pdl.positions[pdl.origin].offset + 1.05)
eq(holdCheck(pdl, pdl.origin, pnext, 75, null, rowAt(0, 50)).over, 0,
   'onto the top tab of a group, the doorway does not throw the aim off')

// ── what a drop does ────────────────────────────────────────────────────────
const L6 = L('p', ['h', G], ['m', G], 'y')
eq(resolveDrop(L6, 'p', { before: 'm', group: G }),
   { ids: ['h', 'p', 'm', 'y'], groups: [G, G, G, ''] }, 'dropped between members, it joins')
eq(resolveDrop(L1, 'n', { before: 'y', group: null }),
   { ids: ['x', 'h', 'm', 'n', 'y'], groups: ['', G, G, '', ''] }, 'out through the bottom doorway')
eq(resolveDrop(L2, 'h', { before: 'm', group: null }),
   { ids: ['h', 'm', 'n', 'y'], groups: ['', G, G, ''] }, 'out through the top doorway')
const L7 = L(['h', G], ['m', G], 'y')
eq(resolveDrop(L7, 'm', { before: 'y', group: null }),
   { ids: ['h', 'm', 'y'], groups: ['', '', ''] }, 'leaving a group of two leaves no group of one')
const fresh = newGroupId([], NOW, R0)
eq(resolveDrop(L('a', 'b', 'c'), 'c', { onto: 'a' }, NOW, R0),
   { ids: ['a', 'c', 'b'], groups: [fresh, fresh, ''] }, 'held over a plain tab: a new group, the dragged tab second')
const L8 = L(['h', G], ['m', G], 'z')
eq(resolveDrop(L8, 'z', { onto: 'h' }),
   { ids: ['h', 'z', 'm'], groups: [G, G, G] }, 'held over a grouped tab: it joins, directly under it')
const L9 = L(['a', G], 'b')
const r9 = resolveDrop(L9, 'b', { onto: 'a' }, NOW, R0)
r9.groups[0] === r9.groups[1] && r9.groups[0] !== G && validGroup(r9.groups[0])
  ? ok('held over a tab with a stale single id: a fresh group, not the stale one')
  : bad(`stale single: ${JSON.stringify(r9)}`)
const L10 = L(['h', G], ['m', G], 'p')
eq(resolveDrop(L10, 'p', { before: 'm', group: null }),
   { ids: ['h', 'p', 'm'], groups: [G, G, G] }, 'between two members is inside, whatever the caller said')
const L11 = L(['h', G], ['m', G], ['c', H], ['d', H])
eq(resolveDrop(L11, 'c', { before: 'm', group: null }),
   { ids: ['h', 'c', 'm', 'd'], groups: [G, G, G, ''] },
   'a tab of one group dropped between two of another joins that one, and leaves no group of one behind')
eq(resolveDrop(L1, 'n', { before: 'gone', group: null }), null,
   'a drop next to a tab that vanished meanwhile does nothing')
eq(resolveDrop(L('a', ['b', 'junk']), 'a', { before: null, group: null }).groups,
   ['', ''], 'a garbage id on disk is written back as no group')
/* Review: settling a split id keeps the run that is actually drawn as the
   group, so an unrelated drop elsewhere cannot recolour it. */
const strayL = L(['c', G], 'x', ['a', G], ['b', G], 'y')
eq(resolveDrop(strayL, 'y', { before: 'x', group: null }, NOW, R0),
   { ids: ['c', 'y', 'x', 'a', 'b'], groups: ['', '', '', G, G] },
   "a stray tab with a live group's id loses it; the drawn group keeps its id and colour")

// ── every drop leaves a sound rail ──────────────────────────────────────────
function sound(r, before){
  if (!r) return 'null'
  if (JSON.stringify([...r.ids].sort()) !== JSON.stringify(before.map(s => s.id).sort())) return 'lost or duplicated a tab'
  const runs = [], count = new Map()
  r.groups.forEach((g, i) => {
    if (g && !validGroup(g)) runs.push('bad id')
    if (g) count.set(g, (count.get(g) ?? 0) + 1)
    if (g && (i === 0 || r.groups[i - 1] !== g)) runs.push(g)
  })
  for (const [g, n] of count) if (n < 2) return `group of one (${g})`
  if (new Set(runs).size !== runs.length) return 'split group'
  return ''
}
const L4 = L('a', ['h', G], ['m', G], 'b', ['c', H], ['d', H], 'e')
const LAYOUTS = [
  L1, L2, L3, L4, L6, L7, L8, L9, L10, L11,
  L('a', 'b', 'c'),
  L(['a', G], ['b', G], ['c', H], ['d', H], ['e', H]),
  L(['a', G], 'b', ['c', G], ['d', G]),                     // a split group on disk
]
let checked = 0, broken = []
for (const lay of LAYOUTS) for (const { id } of lay) {
  for (const p of dropLayout(lay, id).positions) {
    const r = resolveDrop(lay, id, { before: p.before, group: p.group }, NOW, Math.random)
    const why = sound(r, lay); checked++
    if (why) broken.push(`${JSON.stringify(lay)} drag ${id} → ${JSON.stringify(p)}: ${why}`)
  }
  for (const { id: t } of lay) if (t !== id) {
    const r = resolveDrop(lay, id, { onto: t }, NOW, Math.random)
    const why = sound(r, lay); checked++
    if (why) broken.push(`${JSON.stringify(lay)} hold ${id} onto ${t}: ${why}`)
  }
}
broken.length ? bad(`${broken.length} of ${checked} drops left an unsound rail:\n      ` + broken.slice(0, 5).join('\n      '))
              : ok(`all ${checked} possible drops across ${LAYOUTS.length} layouts leave no group of one and no split group`)

console.log(`\n  ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
console.log('  group decisions hold.\n')
