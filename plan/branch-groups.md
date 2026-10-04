# oneterm — branch groups in the rail

Written 2026-10-04. Status: designed, not built.

Mockup: https://claude.ai/artifact/E6vrcozEQZGoTw1A36MAW3

---

## What it is for

Branching puts a new tab directly under the one it came from, labelled
`↳ <parent>`. That holds for about ten minutes. Then a branch gets renamed
("redis cache try"), something gets dragged between them, and the rail no longer
says which tabs are the same piece of work. A **group** says it permanently:
the tabs share a colour line and a faint tint, and the group collapses to one
row when you are not looking at it.

## What a group is

- A set of tabs that carry the same group id and sit **next to each other** in
  the rail. Order inside the group is ordinary rail order.
- The **top tab** of a group is its head. There is no separate header row: the
  head carries the group's chip. Whichever tab is on top is the head, so
  moving or closing the head promotes the next one.
- A group with **one** tab left is drawn as a plain tab. Its id stays on the
  tab and is harmless; if the tab gets a sibling again it is that group again,
  colour and all.
- Groups have **no names**. There is no header row to put one in, and the head
  tab's own name already says what the group is.

## How it looks

Drawn in the rail's existing tokens. The mockup is the reference.

| Part | Look |
|---|---|
| Group line | 2px, group colour at ~55%, in the rail's 10px left margin (x ≈ 3–5px), from the first row's top inset to the last row's bottom inset. Rows are **not** indented, so names keep their full width. |
| Tint | The group colour at ~6% behind the whole group, 5px radius, 3px margin above and below the group. |
| Chip | On the head's title line, after the `CC`/`SH` tag. Group colour on the group's soft colour, mono 9px, pill. Expanded: `<count> ▾`. Collapsed: `+<hidden> ●● ▸`. |
| Mini dots | Collapsed only: one 5px dot per hidden tab, in the rail's status language (hollow idle, accent working, green done, amber waiting with the ping). At most 4; past that, the count says it. |
| Collapsed head | Its dot is its own state. Its wash and left bar are the **group's**: the wash is "you are here" when the active tab is inside, else amber when any tab waits; the bar is amber if any tab waits, else accent if any works, else green if any finished unseen, else accent if the active tab is inside. Nothing that needs you can hide in a collapsed group. |

The status colours are vermillion (working), amber (waiting) and green
(done), so group colours keep clear of all three. Five colours, light / dark:

| # | Name | Light | Dark |
|---|---|---|---|
| 0 | ai (indigo) | `#3D5A80` | `#8FA8CC` |
| 1 | plum | `#7A4C70` | `#C99BBE` |
| 2 | slate teal | `#3B6B73` | `#86B7BE` |
| 3 | wisteria | `#6A5A9A` | `#A99BD6` |
| 4 | stone | `#5E6670` | `#A3ABB5` |

## How you use it

### Forming and growing

| You do | Result |
|---|---|
| Branch a plain tab | The tab and its branch become a new group, branch under the tab |
| Branch a tab that is in a group | The branch joins that group, directly under the tab it came from |
| Drag a tab and **hold ~0.4s** over a plain tab | The two become a new group, the dragged tab second |
| Drag a tab and hold over a tab that is in a group | The dragged tab joins that group, directly under the held-over tab |
| Drop a tab between two tabs of a group | It joins that group |

### Leaving: the edge is a doorway

A group's top and bottom edges each cost **half a row** of extra travel to
cross. A tab dragged to a group's edge first lands *inside* it, at the edge;
another half row takes it *outside*. Leaving and entering work the same way, in
both directions, including for a group at the very top of the rail, where
there is nothing above it to drop onto.

The held row is the preview, so you always see where it will land before you
let go:

- It shows the group line on its left in the colour of the group it would land in, or none.
- A pill in its top-right corner says `ungroup` (in the old group's colour) when the drop would take it out of a group, or `join` (in the new group's colour) when the drop would put it into one.
- When armed for grouping (below), the tab underneath shows a dashed ring and a `group` pill.

### Hold to group

While dragging, the gap only moves once the held row's centre passes the
**outer quarter** of a neighbour. In the neighbour's **middle half** the held
row is *over* it, and nothing shifts. Hold there for 400ms and grouping arms.
Moving more than a few px, or out of the middle half, disarms it. A quick drag
straight past a tab only reorders, as today.

Grouping never arms when:
- the held-over tab is already in the dragged tab's group, which would change nothing, or
- the drag is a whole collapsed group. **Groups never merge or nest.**

A collapsed group being dragged only reorders. Its drop positions skip the
inside of other groups, so it hops over them whole.

### Collapsing

- Click the chip to collapse or expand. Clicking the chip never switches tabs.
- **What you see is what you drag.** Dragging the head of a *collapsed* group
  moves the whole group, and its hidden tabs go with it. Dragging any tab of an
  *expanded* group moves that tab alone.
- **Switching to a hidden tab expands its group.** That covers a notification
  click, a `/#<id>` link, ⌘⇧B creating a branch inside a collapsed group, and
  anything else that goes through `switchTo`. You may still collapse the group
  you are in: its head then carries "you are here".

## Where the state lives

| State | Stored in | Why |
|---|---|---|
| Which group a tab is in | tmux user-option `@oneterm_group` on the tab's session, next to `@oneterm_order` and `@oneterm_label` | tmux is the source of truth. Groups survive reloads, host restarts and crashes, every browser window sees the same ones, and a group can never outlive its tabs. |
| Collapsed / expanded | `localStorage['oneterm-collapsed']`, a JSON array of group ids | A viewing preference, like theme and sound. Ids of groups no longer in the rail are pruned on paint. |

**The group id** is `<colour>.<base36 time><2 random base36>`, for example
`2.lq3k9xa7`, and must match `/^[0-4]\.[0-9a-z]{6,14}$/`. The colour lives in
the id, so it needs no storage of its own and a group keeps it for life. A
new group takes the colour used by the **fewest** existing groups; ties go to
the lowest index.

## `groups.mjs`: the pure parts

This follows `branch.mjs`: pure functions, so the tests run the code that
ships. Unlike `branch.mjs` it also runs **in the page**. The drag logic lives
here, so the code that decides where a drop lands is the code under test.

- `GROUP_ID`: the regex above, shared by the server's validation and the tests.
- `newGroupId(existingIds, now, rand)` returns a fresh id with the least-used colour.
- `groupColor(id)` returns the colour index, or `null` for anything invalid.
- `railItems(sessions)` returns the rail as `{ kind: 'tab', s }` and
  `{ kind: 'group', id, color, members }`, where a group is a **contiguous run
  of ≥2** tabs with the same valid id. A split group, which should never happen,
  draws as two runs rather than crashing.
- `branchGroup(parent, existingIds, now, rand)` returns
  `{ group, parentNeedsIt }`: the parent's group, or a new one that the parent
  must also be given.
- `dropPositions(items, dragUnit)` returns the ordered drop positions, each
  `{ index, group, cost }`. Doorways are the half-cost positions at group
  edges. `dragUnit` is one tab, or a collapsed group's whole run.
- `resolveDrop(sessions, dragUnit, position | { onto: id }, now, rand)` returns
  `{ ids, groups }`: the full new rail order, plus the group (or `''`) for
  every tab, parallel to `ids`. It handles join, leave, new group by hold, and
  whole-group moves, and leaves no group with one tab and no split group.

## Host (`server.mjs`)

- **`listSessions`** reads `#{@oneterm_group}` as a tenth field (`FIELDS` 9 → 10)
  and returns `group`, which is `null` unless it matches `GROUP_ID`.
- **`/reorder`** accepts an optional `groups=` list parallel to `ids=`
  (comma-separated, an empty slot means no group).
  - Every non-empty slot must match `GROUP_ID`, and `groups` must be as long as
    `ids`. Otherwise the route returns **400** `bad_groups` and writes nothing.
  - It writes the order exactly as now, through `writeOrder`. It sets or
    unsets `@oneterm_group` only where the value changed (it lists sessions
    first).
  - Without `groups=` it behaves exactly as today, so an old page open in
    another window cannot wipe groups.
- **`/branch`** calls `branchGroup` after the session exists. It sets the
  group on the branch, and on the parent too when the group is new. Placement
  is unchanged (`orderAfter`), and that keeps the group contiguous.
- **Serving `groups.mjs`**: a fixed route `/groups.mjs` →
  `ROOT/groups.mjs`, plus `'.mjs': 'text/javascript'` in `TYPES`. A module
  served as `text/plain` is refused by the browser.

## Client (`public/index.html`)

- **Loading the module**: the inline script stays classic. It does
  `import('/groups.mjs')` at start-up and repaints when the module arrives.
  Until then, or if it fails, the rail paints flat exactly as today, so a
  missing module can never cost you the rail.
- **`paintRail`** renders `railItems`: a `.grp` wrapper holding the line, the
  tint and the member rows, the head's chip, and collapsed heads with their
  mini dots and group wash. Every row stays a `.sess`, and its handlers are
  unchanged.
- **`refresh`** adds `s.group` to the rail signature, so a group change made in
  another window repaints this one.
- **Drag** (`beginDrag` / `onDragMove` / `layoutGap` / `endDrag`):
  - Rows are collected as the visible `.sess` in order, not the list's
    children (groups wrap theirs).
  - The step-to-index mapping goes through `dropPositions`, so doorways cost
    half a row.
  - The held row's preview is the group line plus the `ungroup` / `join` pill.
  - Hold-to-group uses a 400ms timer, armed only while the centre stays in a
    neighbour's middle half.
  - The drop goes through `resolveDrop`. Then it updates optimistically, as
    now, and POSTs `/reorder?ids=…&groups=…`.
- **Collapse**: a click on the chip toggles the id in
  `localStorage['oneterm-collapsed']` (wrapped in try/catch, like the rest of
  the page's storage) and repaints. `switchTo(id)` removes the id's group from
  the set first.

## Known limits

- **Collapsed state is per browser profile.** Another Chrome profile shows the
  same groups, expanded.
- **A drag in a stale window.** The page sends the whole layout, so a drop in
  a window that has not polled since another window changed the groups writes
  its older view, the same last-writer-wins `/reorder` has today. The 4s poll
  keeps that window short.
- **Rows inside a group have the same width as rows outside it.** The line and
  tint carry the grouping, so nothing is indented and no name is shortened.

## Not in this change

- Group names or rename.
- Keyboard shortcuts for grouping, ungrouping or collapsing.
- A "close the whole group" action.
- Syncing collapsed state through tmux.

## Verification

- **`test/groups.test.mjs`**, in the repo's `ok()` / `bad()` style. Added to
  `bin/reload.sh`'s gate and to CI (pure, so it needs no tmux). It covers:
  - `railItems`: plain tabs, a group, a group of one drawn plain, a split group drawn as two runs, invalid ids ignored.
  - `newGroupId`: least-used colour, ties, format matches `GROUP_ID`.
  - `branchGroup`: a plain parent gets a new group for both, a grouped parent shares its group.
  - `resolveDrop`:
    - join between members
    - leave through the top and the bottom doorway
    - stay inside at the edge
    - a group at the top of the rail
    - hold onto a plain tab makes a new group
    - hold onto a grouped tab joins it, under that tab
    - moving a collapsed group keeps it whole and hops over other groups
    - hold onto a tab of your own group, or with a collapsed group, does nothing
    - no result ever leaves a group with one tab or a split group
- **`test/e2e-branch.sh`** grows two checks:
  - After a branch of a plain tab, both tabs report the same valid `group`.
  - A branch of that branch reports it too.
- **`/reorder` with a bad `groups=`** returns 400 and changes nothing (e2e).
- **By hand, in the real app** on a second host on port 7332 from the worktree:
  - branch twice
  - collapse and expand
  - drag out through each doorway and back in
  - hold-to-group on a plain tab and on a grouped tab
  - move a collapsed group
  - a waiting tab inside a collapsed group turns the head amber
  - the rail in dark mode
