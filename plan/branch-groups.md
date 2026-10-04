# oneterm — branch groups in the rail

Written 2026-10-04. Status: built.

Mockup: https://claude.ai/artifact/E6vrcozEQZGoTw1A36MAW3 (updated to what
shipped).

**Decided 2026-10-04:** groups do **not** collapse. That was dropped after the
first build, once groups were seen working. Without collapsing, the top tab's
chip had no job left, so there is no chip either: a group is its line and its
tint, and nothing else.

---

## What it is for

Branching puts a new tab directly under the one it came from, labelled
`↳ <parent>`. That holds for about ten minutes. Then a branch gets renamed
("redis cache try"), something gets dragged between them, and the rail no longer
says which tabs are the same piece of work. A **group** says it permanently:
the tabs share a colour line and a faint tint.

## What a group is

- A set of tabs that carry the same group id and sit **next to each other** in
  the rail. Order inside the group is ordinary rail order.
- There is no header row, no chip and nothing to collapse. Every tab in a group
  is an ordinary row, and every one is dragged on its own.
- A group with **one** tab left is drawn as a plain tab. Its id stays on the
  tab and is harmless; if the tab gets a sibling again through a branch, it is
  that group again, colour and all — unless another tab still carries that id,
  in which case the branch starts a new group rather than a split one.
- Groups have **no names**. The tabs' own names already say what the group is.

## How it looks

Drawn in the rail's existing tokens.

| Part | Look |
|---|---|
| Group line | 2px, group colour at 55%, in the rail's 10px left margin (x ≈ 3–5px), from the first row's top inset to the last row's bottom inset. Rows are **not** indented, so names keep their full width. |
| Tint | The group colour at 6% behind the whole group, 5px radius, 3px margin above and below the group. |

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
| Branch a plain tab | The tab and its branch become a new group, the branch under the tab |
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
- When armed for grouping (below), the tab underneath shows a dashed ring and a `group` pill, in the colour the group will have.
- Mid-drag, each member row carries its own share of the line and the tint, so they travel with the rows as the rows slide aside.

### Hold to group

**Over a tab is judged on screen** (`holdCheck`): the held row's centre lies
in the middle half of a neighbouring tab as drawn right now.

- **Hold there for 400ms** and grouping arms. Every few px of movement restarts the clock, so a slow drag past a tab never groups by accident. Leaving the middle half disarms it.
- **Armed:**
  - The held row turns see-through, so the tab under it shows its dashed ring.
  - The `group` pill sits on the held row, where nothing can cover it, in the colour the group will have.
- **A tab you could group with holds still** until the held row's centre passes its middle; only then does it slide aside as a reorder. A phone's home screen tells "make a folder" from "rearrange" the same way.
- **A tab already in the dragged tab's group** reorders as it always did, and is never "over".

**Fixed 2026-10-04, after real use:** "over" was first measured in travel
units, the layout's rows-of-travel scale. Those charge half a row extra at
group edges and are offset from the pixels the eye lines up, so a tab dragged
squarely onto another had already slid it away. The armed ring was also
hidden under the opaque held row.

## Where the state lives

| State | Stored in | Why |
|---|---|---|
| Which group a tab is in | tmux user-option `@oneterm_group` on the tab's session, next to `@oneterm_order` and `@oneterm_label` | tmux is the source of truth. Groups survive reloads, host restarts and crashes, every browser window sees the same ones, and a group can never outlive its tabs. |

**The group id** is `<colour>.<base36 time><2 random base36>`, for example
`2.lq3k9xa7`, and must match `/^[0-4]\.[0-9a-z]{6,14}$/`. The colour lives in
the id, so it needs no storage of its own and a group keeps it for life. A
new group takes the colour used by the **fewest** live groups; ties go to the
lowest index.

## `groups.mjs`: the pure parts

This follows `branch.mjs`: pure functions, so the tests run the code that
ships. Unlike `branch.mjs` it also runs **in the page**. The drag logic lives
here, so the code that decides where a drop lands is the code under test.

- `GROUP_ID`: the regex above, shared by the server's validation and the tests.
- `validGroup(g)`, `groupColor(id)`.
- `newGroupId(liveIds, now, rand)` returns a fresh id in the least-used colour.
- `railItems(sessions)` returns the rail as `{ kind: 'tab', s }` and
  `{ kind: 'group', id, color, members }`, where a group is a **contiguous run
  of ≥2** tabs with the same valid id. A split group, which no drop produces,
  draws as two runs rather than crashing.
- `memberMap(sessions)` maps each tab that is drawn in a group to its group.
  `liveGroupIds(sessions)` lists the drawn groups.
- `branchGroup(parent, sessions, now, rand)` returns
  `{ group, parentNeedsIt }`: the parent's group (when it is drawn in it, or
  no other tab carries the id), or a new one that the parent must also be given.
- `dropLayout(sessions, id)` returns `{ positions, rows, origin }`:
  - every place tab `id` can land, each `{ gap, before, group, offset }`;
    doorways are the half-row states at group edges
  - each other row's stretch of travel
  - where the tab already is
- `locate(layout, c)` returns the nearest position to travel `c`.
- `holdCheck(layout, cur, next, mid, above, below)` returns `{ pos, over }`,
  judged in pixels against the rows beside the gap.
- `resolveDrop(sessions, id, target, now, rand)` returns `{ ids, groups }`, or
  `null` when the tab or its landing neighbour has vanished:
  - the full new rail order, plus every tab's group (`''` for none), parallel to `ids`
  - `target` is `{ before, group }`, or `{ onto }` for a hold
  - between two members of one group is always inside it
  - the result never has a group of one or a split group; settling a split id
    keeps its longest run, so a stray tab cannot take a drawn group's colour

## Host (`server.mjs`)

- **`listSessions`** reads `#{@oneterm_group}` as a tenth field and returns
  `group`, which is `null` unless it matches `GROUP_ID`.
- **`/reorder`** accepts an optional `groups=` list parallel to `ids=`
  (comma-separated, an empty slot means no group).
  - Every non-empty slot must match `GROUP_ID`, and `groups` must be as long as
    `ids`. Otherwise the route returns **400** `bad_groups` and writes nothing.
  - It writes the order exactly as before, through `writeOrder`. It sets or
    unsets `@oneterm_group` only where the value changed.
  - Without `groups=` it behaves exactly as it always did, so an old page open
    in another window cannot wipe groups.
- **`/branch`** calls `branchGroup` after placing the branch. It sets the group
  on the branch, and on the parent too when the group is new.
- **Serving `groups.mjs`**: the route `/groups.mjs` serves `ROOT/groups.mjs`
  as `text/javascript` (`'.mjs'` in `TYPES`).
- **The `/sessions` cache and writes** (found while building this):
  - `/reorder` and `/branch` write order and groups one tmux call at a time,
    inside `layoutWrite`: one at a time, and `/sessions` waits for the one in
    flight, so no read sees a tab moved but not yet regrouped.
  - Every layout mutation (`/new`, `/kill`, `/rename`, `/reorder`, `/branch`;
    not the status line's frequent `/agent-event`) bumps a generation at its
    start and end. A `/sessions` read that overlapped one is served but not cached.
  - Before this, a read that began before a `/reorder` could cache the old
    layout for 700ms. A second drag made in that window then sent the old
    groups back, undoing the first drop.

## Client (`public/index.html`)

- **Loading the module**: the inline script stays classic and starts
  `import('/groups.mjs')` up front. Start-up waits for it alongside the
  skills, projects and conversations fetches. If it fails, the rail paints
  flat exactly as it did before groups, so a missing module costs the
  grouping, never the rail. It is retried with a fresh URL (the browser
  remembers a failed import) at 5s, 10s, … up to six times.
- **`paintRail`** renders `railItems`: each group is a `.grp` wrapper,
  `data-c` = its colour, holding its member rows. Every row is still a `.sess`
  built by `rowEl(s)`, with its handlers unchanged.
- **`refresh`**:
  - adds `s.group` to the rail signature
  - drops a poll that overlapped a layout write. `writeLayout` bumps
    `layoutSeq` on both sides of the POST and counts writes in flight; a poll
    that saw the seq change, or finished while a write was pending, may hold
    the layout from before the drop.
- **Drag** (`beginDrag` / `onDragMove` / `layoutGap` / `endDrag`):
  - rows are collected as `.sess`, not the list's children, because groups wrap theirs
  - one row of travel is the held row's own height + 1
  - travel goes through `dropLayout` and `locate`
  - the preview is `paintPreview`; the hold timer is `trackHold`
  - the drop is `dropGrouped`: `resolveDrop`, applied optimistically, then
    `writeLayout('/reorder?ids=…&groups=…')`

## Known limits

- **A drag in a stale window.** The page sends the whole layout, so a drop in
  a window whose last poll predates another window's change writes its older
  view. That is the same last-writer-wins `/reorder` always had, and the 1.5s
  poll keeps the window short.
- **No moving a group as a block.** Every tab moves on its own; moving a group
  is moving its tabs.

## Not in this change

- Collapsing, a chip, or any header row (decided against, above).
- Group names or rename.
- Keyboard shortcuts for grouping or ungrouping.
- A "close the whole group" action.

## Verification

- **`test/groups.test.mjs`**, in the repo's `ok()` / `bad()` style, is gated
  in `bin/reload.sh` and run in CI. It covers:
  - ids and colours: least-used colour, ties, the minted format
  - `railItems`, including a group of one and a split group
  - `branchGroup`
  - the doorway in both directions, including at the top of the rail
  - `locate`'s "over"
  - every kind of drop
  - a sweep of every possible drop across 13 layouts: none leaves a group of
    one or a split group
- **`test/e2e-branch.sh`** additionally checks:
  - a branch and its parent share a valid group, and a branch of a branch shares it too
  - membership is the tmux option
  - a reorder without `groups=` keeps groups
  - a malformed or misaligned `groups=` is 400 and writes nothing
  - a blank slot ungroups one tab without touching the others
  - `/groups.mjs` is served as JavaScript
- **By hand in a browser**, against a host on 7332 from the worktree with its
  own tmux server (`env -u TMUX TMUX_TMPDIR=<short dir>`), so the real rail
  was never touched:
  - branching forms groups in distinct colours
  - out through the bottom and the top doorway
  - into a group between members and at its edge
  - hold-to-group on a plain tab and on a grouped tab
  - two drags back to back, the race that found the cache bug
  - a fast flick, five rows in five pointer samples
  - the join / ungroup / group previews mid-drag
  - dark mode
