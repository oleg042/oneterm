/* The pure half of branch groups: which tabs draw as a group, what colour a
 * new one gets, where a dragged tab can land, and what a drop does. The page
 * imports the same module from /groups.mjs, so this runs the decisions that
 * ship on BOTH sides — the host's and the drag's.
 *   node test/groups.test.mjs
 */
import { GROUP_ID, validGroup, groupColor, newGroupId, railItems, memberMap,
         liveGroupIds, branchGroup, visibleIds, dragUnit, dropLayout, locate,
         resolveDrop } from '../groups.mjs'

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
/* Review focus 5: the collapsed state is keyed by group id, so closing the
   head must leave the same id on the next tab — then it stays collapsed. */
eq(shape(railItems(L(['m', G], ['n', G]))), [[G, ['m', 'n']]],
   'closing the head of a group leaves it the same group, with the next tab on top')
eq([...memberMap(L('a', ['b', G], ['c', G], ['d', H])).entries()], [['b', G], ['c', G]],
   'memberMap lists drawn group members only')
eq(liveGroupIds(L(['a', G], ['b', G], ['c', H])), [G], 'a stale single id is not a live group')

// ── which group a branch lands in ───────────────────────────────────────────
const bg = branchGroup(S('p'), [G], NOW, R0)
bg.parentNeedsIt && GROUP_ID.test(bg.group) && bg.group[0] === '1'
  ? ok('branching a plain tab mints a new group for both, in a free colour')
  : bad(`branchGroup plain: ${JSON.stringify(bg)}`)
eq(branchGroup(S('p', G), [G], NOW, R0), { group: G, parentNeedsIt: false },
   'branching a grouped tab joins its group')

// ── what is visible, and what a drag carries ────────────────────────────────
const L4 = L('a', ['h', G], ['m', G], 'b', ['c', H], ['d', H], 'e')
eq(visibleIds(L4, new Set([G])), ['a', 'h', 'b', 'c', 'd', 'e'], 'a collapsed group shows its head only')
eq(dragUnit(L4, 'h', new Set([G])), { ids: ['h', 'm'], whole: true, group: G },
   'dragging a collapsed head carries the whole group')
eq(dragUnit(L4, 'h', new Set()), { ids: ['h'], whole: false, group: G },
   'dragging an expanded head carries that tab alone')
eq(dragUnit(L4, 'a', new Set()), { ids: ['a'], whole: false, group: null }, 'a plain tab is itself')

// ── drop positions: the doorway ─────────────────────────────────────────────
const at = (lay, i) => [lay.positions[i].gap, lay.positions[i].group]
const L1 = L('x', ['h', G], ['m', G], ['n', G], 'y')
const lay1 = dropLayout(L1, dragUnit(L1, 'n'), new Set())
eq(at(lay1, lay1.origin), [3, G], 'a member starts inside its group')
const c1 = lay1.positions[lay1.origin].offset
eq(at(lay1, locate(lay1, c1 + 0.2, lay1.origin).pos), [3, G], 'a short pull past the edge stays inside')
eq(at(lay1, locate(lay1, c1 + 0.5, lay1.origin).pos), [3, null],
   'half a row past the bottom edge and it is out — the doorway')
eq(at(lay1, locate(lay1, c1 + 1.5, lay1.origin).pos), [4, null], 'another row on and it is past y')

const L2 = L(['h', G], ['m', G], ['n', G], 'y')
const lay2 = dropLayout(L2, dragUnit(L2, 'h'), new Set())
eq(at(lay2, lay2.origin), [0, G], 'the head of a group at the very top starts inside')
eq(at(lay2, locate(lay2, lay2.positions[lay2.origin].offset - 0.5, lay2.origin).pos), [0, null],
   'and leaves upward through the doorway even with nothing above it')

const L3 = L('p', ['h', G], ['m', G], 'y')
eq(dropLayout(L3, dragUnit(L3, 'p'), new Set()).positions.map(p => [p.gap, p.group]),
   [[0, null], [0, G], [1, G], [2, G], [2, null], [3, null]],
   'a plain tab passing a group goes join-at-top, inside, join-at-bottom, out')

const lay4 = dropLayout(L4, dragUnit(L4, 'h', new Set([G])), new Set([G]))
lay4.positions.every(p => p.group === null) && !lay4.positions.some(p => p.gap === 3)
  ? ok('a whole collapsed group only lands outside, and hops over another group whole')
  : bad(`whole-group positions: ${JSON.stringify(lay4.positions)}`)

const L5 = L('x', ['h', G], ['m', G], 'y')
dropLayout(L5, dragUnit(L5, 'x', new Set([G])), new Set([G])).positions.every(p => p.group === null)
  ? ok('a collapsed group offers no inside to drop into — join it by holding over it')
  : bad('collapsed group offered an inside position')

// ── where the pointer is ────────────────────────────────────────────────────
const rowH = lay1.rows.findIndex(r => r.id === 'h')
const mid = (lay1.rows[rowH].from + lay1.rows[rowH].to) / 2
eq(locate(lay1, mid, lay1.origin, () => true), { pos: lay1.origin, over: rowH },
   'the middle half of a tab you could group with is "over" it, and nothing moves')
eq(locate(lay1, mid, lay1.origin, () => false).over, null, 'a tab you cannot group with is never "over"')
eq(at(lay1, locate(lay1, lay1.rows[rowH].to - 0.1, lay1.origin, () => true).pos), [2, G],
   'past the outer quarter the gap moves after all')

// ── what a drop does ────────────────────────────────────────────────────────
const L6 = L('p', ['h', G], ['m', G], 'y')
eq(resolveDrop(L6, dragUnit(L6, 'p'), { before: 'm', group: G }),
   { ids: ['h', 'p', 'm', 'y'], groups: [G, G, G, ''] }, 'dropped between members, it joins')
eq(resolveDrop(L1, dragUnit(L1, 'n'), { before: 'y', group: null }),
   { ids: ['x', 'h', 'm', 'n', 'y'], groups: ['', G, G, '', ''] }, 'out through the bottom doorway')
eq(resolveDrop(L2, dragUnit(L2, 'h'), { before: 'm', group: null }),
   { ids: ['h', 'm', 'n', 'y'], groups: ['', G, G, ''] }, 'out through the top doorway')
const L7 = L(['h', G], ['m', G], 'y')
eq(resolveDrop(L7, dragUnit(L7, 'm'), { before: 'y', group: null }),
   { ids: ['h', 'm', 'y'], groups: ['', '', ''] }, 'leaving a group of two leaves no group of one')
const fresh = newGroupId([], NOW, R0)
eq(resolveDrop(L('a', 'b', 'c'), dragUnit(L('a', 'b', 'c'), 'c'), { onto: 'a' }, NOW, R0),
   { ids: ['a', 'c', 'b'], groups: [fresh, fresh, ''] }, 'held over a plain tab: a new group, the dragged tab second')
const L8 = L(['h', G], ['m', G], 'z')
eq(resolveDrop(L8, dragUnit(L8, 'z'), { onto: 'h' }),
   { ids: ['h', 'z', 'm'], groups: [G, G, G] }, 'held over a grouped tab: it joins, directly under it')
const L9 = L(['a', G], 'b')
const r9 = resolveDrop(L9, dragUnit(L9, 'b'), { onto: 'a' }, NOW, R0)
r9.groups[0] === r9.groups[1] && r9.groups[0] !== G && validGroup(r9.groups[0])
  ? ok('held over a tab with a stale single id: a fresh group, not the stale one')
  : bad(`stale single: ${JSON.stringify(r9)}`)
eq(resolveDrop(L4, dragUnit(L4, 'h', new Set([G])), { onto: 'b' }), null,
   'a whole group cannot be held onto anything — groups never merge')
eq(resolveDrop(L4, dragUnit(L4, 'h', new Set([G])), { before: 'e', group: null }),
   { ids: ['a', 'b', 'c', 'd', 'h', 'm', 'e'], groups: ['', '', H, H, G, G, ''] },
   'a collapsed group moves whole and keeps its id')
const L10 = L(['h', G], ['m', G], 'p')
eq(resolveDrop(L10, dragUnit(L10, 'p'), { before: 'm', group: null }),
   { ids: ['h', 'p', 'm'], groups: [G, G, G] }, 'between two members is inside, whatever the caller said')
const L11 = L(['h', G], ['m', G], ['c', H], ['d', H])
eq(resolveDrop(L11, dragUnit(L11, 'c', new Set([H])), { before: 'm', group: null }), null,
   'a whole group dropped inside another is refused — groups never nest')
eq(resolveDrop(L1, dragUnit(L1, 'n'), { before: 'gone', group: null }), null,
   'a drop next to a tab that vanished meanwhile does nothing')
eq(resolveDrop(L('a', ['b', 'junk']), dragUnit(L('a', ['b', 'junk']), 'a'), { before: null, group: null }).groups,
   ['', ''], 'a garbage id on disk is written back as no group')

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
const LAYOUTS = [
  L1, L2, L3, L4, L6, L7, L8, L9, L10, L11,
  L('a', 'b', 'c'),
  L(['a', G], ['b', G], ['c', H], ['d', H], ['e', H]),
  L(['a', G], 'b', ['c', G], ['d', G]),                     // a split group on disk
]
let checked = 0, broken = []
for (const lay of LAYOUTS) for (const col of [new Set(), new Set([G]), new Set([H]), new Set([G, H])]) {
  for (const id of visibleIds(lay, col)) {
    const unit = dragUnit(lay, id, col)
    const d = dropLayout(lay, unit, col)
    for (const p of d.positions) {
      const r = resolveDrop(lay, unit, { before: p.before, group: p.group }, NOW, Math.random)
      const why = sound(r, lay); checked++
      if (why) broken.push(`${JSON.stringify(lay)} drag ${id} → ${JSON.stringify(p)}: ${why}`)
    }
    if (!unit.whole) for (const t of visibleIds(lay, col)) if (t !== id) {
      const r = resolveDrop(lay, unit, { onto: t }, NOW, Math.random)
      const why = sound(r, lay); checked++
      if (why) broken.push(`${JSON.stringify(lay)} hold ${id} onto ${t}: ${why}`)
    }
  }
}
broken.length ? bad(`${broken.length} of ${checked} drops left an unsound rail:\n      ` + broken.slice(0, 5).join('\n      '))
              : ok(`all ${checked} possible drops across ${LAYOUTS.length} layouts leave no group of one and no split group`)

console.log(`\n  ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
console.log('  group decisions hold.\n')
