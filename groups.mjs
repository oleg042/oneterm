/* Branch groups — the decisions, kept pure so test/groups.test.mjs runs the
 * code that ships. Unlike branch.mjs this module also runs IN THE PAGE (served
 * at /groups.mjs): where a dragged tab lands is decided here and nowhere else,
 * so the drag the hand feels is the drag the tests check.
 *
 * A group is the tabs that carry one @oneterm_group id and sit next to each
 * other in the rail. The top one carries the chip; there is no header row. A
 * tab left on its own is drawn plain. Spec: plan/branch-groups.md. */

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
 * same group it was, colour and all.
 */
export function branchGroup(parent, liveIds, now = Date.now(), rand = Math.random){
  if (validGroup(parent?.group)) return { group: parent.group, parentNeedsIt: false }
  return { group: newGroupId(liveIds, now, rand), parentNeedsIt: true }
}

/** The rows on screen, top to bottom: a collapsed group shows its head only. */
export function visibleIds(sessions, collapsed = new Set()){
  const out = []
  for (const it of railItems(sessions)){
    if (it.kind === 'tab') out.push(it.s.id)
    else if (collapsed.has(it.id)) out.push(it.members[0].id)
    else for (const s of it.members) out.push(s.id)
  }
  return out
}

/**
 * What a press on row `id` drags. What you see is what you drag: the head of
 * a COLLAPSED group carries the whole group; any other row is one tab.
 */
export function dragUnit(sessions, id, collapsed = new Set()){
  for (const it of railItems(sessions))
    if (it.kind === 'group' && it.members[0].id === id && collapsed.has(it.id))
      return { ids: it.members.map(s => s.id), whole: true, group: it.id }
  return { ids: [id], whole: false, group: memberMap(sessions).get(id) ?? null }
}

/**
 * Everywhere `unit` can land, in pointer order, each with an `offset` in rows
 * of travel.
 *
 * `gap` k sits between the k-th and (k+1)-th of the OTHER visible rows. A gap
 * at a group's edge has more than one state — inside at the edge, outside —
 * half a row apart: that is the doorway, and it is what lets a tab leave a
 * group with nothing beyond it (the top of the rail) and lets the hand feel
 * the boundary rather than guess it. Between two members there is only
 * inside. A collapsed group has no inside to drop into (join it by holding
 * over it), and a whole group never lands inside another: groups never nest.
 *
 * `rows[r]` is the r-th other row and the stretch of travel it occupies, from
 * the last state before it to the first after it — `locate` reads "over a
 * tab" from it. `origin` is where the unit already is.
 */
export function dropLayout(sessions, unit, collapsed = new Set()){
  const gm = memberMap(sessions)
  const vis = visibleIds(sessions, collapsed)
  const head = unit.ids[0]
  const k0 = Math.max(0, vis.indexOf(head))
  const others = vis.filter(id => id !== head)
  const inside = id => {
    const g = id === undefined ? undefined : gm.get(id)
    return g && !collapsed.has(g) ? g : null
  }
  const positions = [], rows = []
  let cursor = 0
  for (let k = 0; k <= others.length; k++){
    if (k > 0){ cursor += 1; rows.push({ id: others[k - 1], from: cursor - 1, to: cursor }) }
    const gL = inside(others[k - 1]), gR = inside(others[k])
    const states = gL && gL === gR ? (unit.whole ? [] : [gL])
                 : unit.whole ? [null]
                 : [...(gL ? [gL] : []), null, ...(gR ? [gR] : [])]
    states.forEach((group, i) =>
      positions.push({ gap: k, before: others[k] ?? null, group, offset: cursor + i / 2 }))
    if (states.length) cursor += (states.length - 1) / 2
  }
  const want = unit.whole ? null : unit.group
  let origin = positions.findIndex(p => p.gap === k0 && p.group === want)
  if (origin < 0) origin = Math.max(0, positions.findIndex(p => p.gap === k0))
  return { positions, rows, origin }
}

/**
 * Where travel `c` (in rows, on the layout's scale) puts the drag.
 *
 * In the middle half of a row it is OVER that tab, provided it is one the
 * drag could group with: the gap stays where it was, which is what lets a
 * hold land on a tab instead of the tab sliding out from under it. Anywhere
 * else it is the nearest position.
 */
export function locate(layout, c, cur, holdable = () => false){
  for (let r = 0; r < layout.rows.length; r++){
    const { from, to } = layout.rows[r], q = (to - from) / 4
    if (c > from + q && c < to - q && holdable(r)) return { pos: cur, over: r }
  }
  let pos = 0, best = Infinity
  layout.positions.forEach((p, i) => {
    const d = Math.abs(p.offset - c)
    if (d < best){ best = d; pos = i }
  })
  return { pos, over: null }
}

/**
 * What a drop does, as the whole rail: the new order, and the group of every
 * tab in it ('' for none), ready for /reorder?ids=…&groups=….
 *
 * `target` is a position — `{ before, group }`, `before` being the row the
 * unit lands above (null: the bottom) — or `{ onto }`, a hold over a tab:
 * join its group directly under it, or start a new group with it.
 *
 * Returns null for a drop that cannot happen: a target that vanished
 * meanwhile, a whole group held onto a tab (groups never merge) or dropped
 * between two members of another (groups never nest).
 *
 * Whatever comes in, what goes out has no group of one and no split group.
 */
export function resolveDrop(sessions, unit, target, now = Date.now(), rand = Math.random){
  const gm = memberMap(sessions)
  const moving = new Set(unit.ids)
  const rest = sessions.filter(s => !moving.has(s.id))
  const units = sessions.filter(s => moving.has(s.id))
  if (!units.length || !target) return null
  const grp = new Map(sessions.map(s => [s.id, validGroup(s.group) ? s.group : '']))
  let at, g
  if ('onto' in target){
    if (unit.whole) return null
    const t = rest.findIndex(s => s.id === target.onto)
    if (t < 0) return null
    g = gm.get(target.onto)
    if (!g){ g = newGroupId(liveGroupIds(sessions), now, rand); grp.set(target.onto, g) }
    at = t + 1
  } else {
    at = target.before == null ? rest.length : rest.findIndex(s => s.id === target.before)
    if (at < 0) return null
    g = unit.whole ? grp.get(unit.ids[0]) : (target.group ?? '')
    if (g && !validGroup(g)) return null
    /* Between two members of one group is inside it, whatever the caller
       said: a tab joins, and a whole group is refused. */
    const above = at > 0 ? grp.get(rest[at - 1].id) : ''
    const below = at < rest.length ? grp.get(rest[at].id) : ''
    if (above && above === below && above !== g){
      if (unit.whole) return null
      g = above
    }
  }
  if (!unit.whole) for (const id of unit.ids) grp.set(id, g)
  const next = [...rest.slice(0, at), ...units, ...rest.slice(at)]
  settle(next, grp, sessions, now, rand)
  return { ids: next.map(s => s.id), groups: next.map(s => grp.get(s.id)) }
}

/* A split group keeps its first run and every later run becomes a group of its
   own; then any group left with one tab is no group. Both only matter for a
   rail that arrived broken — a drop between sound states never splits. */
function settle(list, grp, sessions, now, rand){
  const seen = new Set(), live = liveGroupIds(sessions)
  let n = 0
  for (let i = 0; i < list.length; ){
    const g = grp.get(list[i].id)
    let j = i + 1
    if (g) while (j < list.length && grp.get(list[j].id) === g) j++
    if (g && seen.has(g)){
      const fresh = newGroupId(live, now + ++n, rand); live.push(fresh)
      for (let k = i; k < j; k++) grp.set(list[k].id, fresh)
    }
    if (g) seen.add(g)
    i = j
  }
  const count = new Map()
  for (const s of list){ const g = grp.get(s.id); if (g) count.set(g, (count.get(g) ?? 0) + 1) }
  for (const s of list) if (count.get(grp.get(s.id)) === 1) grp.set(s.id, '')
}
