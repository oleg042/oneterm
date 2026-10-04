/* Branch groups — the decisions, kept pure so test/groups.test.mjs runs the
 * code that ships. Unlike branch.mjs this module also runs IN THE PAGE (served
 * at /groups.mjs): where a dragged tab lands is decided here and nowhere else,
 * so the drag the hand feels is the drag the tests check.
 *
 * A group is the tabs that carry one @oneterm_group id and sit next to each
 * other in the rail: no header row, nothing to collapse — a line and a tint.
 * A tab left on its own is drawn plain. Spec: plan/branch-groups.md. */

/* `<colour>.<base36 time><2 random>`. It reaches a tmux option, so it is
   matched exactly and nothing looser — the same rule as CONV_ID. The colour
   lives in the id, so a group keeps it for life without a second option. */
export const GROUP_ID = /^[0-4]\.[0-9a-z]{6,14}$/
export const COLORS = 5

export const validGroup = g => typeof g === 'string' && GROUP_ID.test(g)
export const groupColor = id => validGroup(id) ? Number(id[0]) : null

/**
 * A fresh id in the colour the fewest live groups use; ties go to the lowest
 * index, so the first groups are told apart by the most distinct colours.
 */
export function newGroupId(liveIds, now = Date.now(), rand = Math.random){
  const used = new Array(COLORS).fill(0)
  for (const id of new Set(liveIds)) { const c = groupColor(id); if (c !== null) used[c]++ }
  const color = used.indexOf(Math.min(...used))
  const time = Math.floor(now).toString(36).padStart(6, '0').slice(-12)
  const tail = Math.min(1295, Math.floor(rand() * 1296)).toString(36).padStart(2, '0')
  return color + '.' + time + tail
}

/**
 * The rail as drawn: plain tabs, and groups — a CONTIGUOUS run of two or more
 * tabs with one valid id. A run of one is a plain tab. A group split in two
 * (which no drop produces) draws as two runs rather than as anything stranger.
 */
export function railItems(sessions){
  const out = []
  for (let i = 0; i < sessions.length; ){
    const g = sessions[i].group
    let j = i + 1
    if (validGroup(g)) while (j < sessions.length && sessions[j].group === g) j++
    if (j - i >= 2) out.push({ kind: 'group', id: g, color: groupColor(g), members: sessions.slice(i, j) })
    else for (let k = i; k < j; k++) out.push({ kind: 'tab', s: sessions[k] })
    i = j
  }
  return out
}

/** tab id → group id, for tabs that are drawn inside a group. */
export function memberMap(sessions){
  const m = new Map()
  for (const it of railItems(sessions))
    if (it.kind === 'group') for (const s of it.members) m.set(s.id, it.id)
  return m
}

export const liveGroupIds = sessions =>
  railItems(sessions).filter(i => i.kind === 'group').map(i => i.id)

/**
 * The group a new branch joins: its parent's, or a new one the parent joins
 * too. A parent holding a stale single id gets it back as a real group — the
 * same group it was, colour and all — but only while no other tab carries
 * that id: reusing an id that still lives elsewhere would put the branch in
 * a second run of it, a split group.
 */
export function branchGroup(parent, sessions, now = Date.now(), rand = Math.random){
  const g = parent?.group
  if (validGroup(g) && (memberMap(sessions).get(parent.id) === g
                        || !sessions.some(s => s.id !== parent.id && s.group === g)))
    return { group: g, parentNeedsIt: false }
  return { group: newGroupId(liveGroupIds(sessions), now, rand), parentNeedsIt: true }
}

/**
 * Everywhere the dragged tab `id` can land, in pointer order, each with an
 * `offset` in rows of travel.
 *
 * `gap` k sits between the k-th and (k+1)-th of the OTHER rows. A gap at a
 * group's edge has more than one state — inside at the edge, outside — half a
 * row apart: that is the doorway, and it is what lets a tab leave a group with
 * nothing beyond it (the top of the rail) and lets the hand feel the boundary
 * rather than guess it. Between two members there is only inside.
 *
 * `rows[r]` is the r-th other row and the stretch of travel it occupies, from
 * the last state before it to the first after it — `locate` reads "over a
 * tab" from it. `origin` is where the tab already is.
 */
export function dropLayout(sessions, id){
  const gm = memberMap(sessions)
  const ids = sessions.map(s => s.id)
  const k0 = Math.max(0, ids.indexOf(id))
  const others = ids.filter(x => x !== id)
  const inside = x => (x === undefined ? null : gm.get(x) ?? null)
  const positions = [], rows = []
  let cursor = 0
  for (let k = 0; k <= others.length; k++){
    if (k > 0){ cursor += 1; rows.push({ id: others[k - 1], from: cursor - 1, to: cursor }) }
    const gL = inside(others[k - 1]), gR = inside(others[k])
    const states = gL && gL === gR ? [gL] : [...(gL ? [gL] : []), null, ...(gR ? [gR] : [])]
    states.forEach((group, i) =>
      positions.push({ gap: k, before: others[k] ?? null, group, offset: cursor + i / 2 }))
    if (states.length) cursor += (states.length - 1) / 2
  }
  const want = gm.get(id) ?? null
  let origin = positions.findIndex(p => p.gap === k0 && p.group === want)
  if (origin < 0) origin = Math.max(0, positions.findIndex(p => p.gap === k0))
  return { positions, rows, origin }
}

/**
 * Where travel `c` (in rows, on the layout's scale) puts the drag.
 *
 * In the middle half of a row it is OVER that tab, provided it is one the
 * dragged tab could group with and the gap is right beside it: the gap stays
 * where it was, which is what lets a hold land on a tab instead of the tab
 * sliding out from under it. "Right beside" matters for a fast flick — the
 * pointer is sampled about once a frame and can land mid-row on every row it
 * passes, and without it the gap stayed behind at the start. Anywhere else it
 * is the nearest position.
 */
export function locate(layout, c, cur, holdable = () => false){
  const gap = layout.positions[cur]?.gap
  for (let r = 0; r < layout.rows.length; r++){
    const { from, to } = layout.rows[r], q = (to - from) / 4
    // row r sits between gap r and gap r+1
    if (c > from + q && c < to - q && (gap === r || gap === r + 1) && holdable(r)) return { pos: cur, over: r }
  }
  let pos = 0, best = Infinity
  layout.positions.forEach((p, i) => {
    const d = Math.abs(p.offset - c)
    if (d < best){ best = d; pos = i }
  })
  return { pos, over: null }
}

/**
 * What dropping tab `id` does, as the whole rail: the new order, and the group
 * of every tab in it ('' for none), ready for /reorder?ids=…&groups=….
 *
 * `target` is a position — `{ before, group }`, `before` being the row the
 * tab lands above (null: the bottom) — or `{ onto }`, a hold over a tab:
 * join its group directly under it, or start a new group with it.
 *
 * Returns null for a drop that cannot happen: the tab, or the one it lands
 * next to, vanished meanwhile.
 *
 * Whatever comes in, what goes out has no group of one and no split group.
 */
export function resolveDrop(sessions, id, target, now = Date.now(), rand = Math.random){
  const gm = memberMap(sessions)
  const rest = sessions.filter(s => s.id !== id)
  const self = sessions.find(s => s.id === id)
  if (!self || !target) return null
  const grp = new Map(sessions.map(s => [s.id, validGroup(s.group) ? s.group : '']))
  let at, g
  if ('onto' in target){
    const t = rest.findIndex(s => s.id === target.onto)
    if (t < 0) return null
    g = gm.get(target.onto)
    if (!g){ g = newGroupId(liveGroupIds(sessions), now, rand); grp.set(target.onto, g) }
    at = t + 1
  } else {
    at = target.before == null ? rest.length : rest.findIndex(s => s.id === target.before)
    if (at < 0) return null
    g = target.group ?? ''
    if (g && !validGroup(g)) return null
    // Between two members of one group is inside it, whatever the caller said.
    const above = at > 0 ? grp.get(rest[at - 1].id) : ''
    const below = at < rest.length ? grp.get(rest[at].id) : ''
    if (above && above === below) g = above
  }
  grp.set(id, g)
  const next = [...rest.slice(0, at), self, ...rest.slice(at)]
  settle(next, grp, sessions, now, rand)
  return { ids: next.map(s => s.id), groups: next.map(s => grp.get(s.id)) }
}

/* A split group keeps its LONGEST run (the first, on a tie) and every other
   run becomes a group of its own; then any group left with one tab is no
   group. Longest, not first: a stray tab still carrying a live group's id —
   left by a page from before groups, or a window that could not load
   groups.mjs — must not take the id, and with it the colour, from the group
   actually drawn. Only a rail that arrived broken has runs to settle: a drop
   between sound states never splits one. */
function settle(list, grp, sessions, now, rand){
  const runs = []
  for (let i = 0; i < list.length; ){
    const g = grp.get(list[i].id)
    let j = i + 1
    if (g) while (j < list.length && grp.get(list[j].id) === g) j++
    if (g) runs.push({ g, i, j })
    i = j
  }
  const keep = new Map()
  for (const r of runs){
    const k = keep.get(r.g)
    if (!k || r.j - r.i > k.j - k.i) keep.set(r.g, r)
  }
  const live = liveGroupIds(sessions)
  let n = 0
  for (const r of runs) if (keep.get(r.g) !== r){
    const fresh = newGroupId(live, now + ++n, rand); live.push(fresh)
    for (let k = r.i; k < r.j; k++) grp.set(list[k].id, fresh)
  }
  const count = new Map()
  for (const s of list){ const g = grp.get(s.id); if (g) count.set(g, (count.get(g) ?? 0) + 1) }
  for (const s of list) if (count.get(grp.get(s.id)) === 1) grp.set(s.id, '')
}
