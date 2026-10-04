# Branch Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tabs that belong together are drawn as one group in the rail. A group
forms when you branch, or when you hold a dragged tab over another tab, and it
collapses to its top tab. A tab leaves a group by being dragged out through the
group's edge.

**Architecture:**
- **Pure decisions** live in a new `groups.mjs` at the repo root:
  - how the rail splits into groups
  - colour choice
  - the drop positions with half-step doorways at group edges
  - where the pointer is
  - what a drop does

  The host imports it, and so does the page, which loads the same file from
  `/groups.mjs`. The tests run the code that ships, on both sides.
- **The host** stores membership as the tmux user-option `@oneterm_group`.
  `/reorder` gains an optional parallel `groups=` list, and `/branch` puts a
  branch in its parent's group.
- **The page** draws groups and keeps collapsed state in localStorage.

**Tech Stack:** Node 20 ESM, tmux, plain inline JS/CSS in `public/index.html`.
Tests are plain `node` / `bash` scripts in the repo's `ok()` / `bad()` style,
with no framework.

**Spec:** `plan/branch-groups.md`

## Global Constraints

- Work only in the worktree `.claude/worktrees/branch-groups` (branch
  `worktree-branch-groups`).
  - `node_modules` there is a symlink to the main checkout's, so never `git add -A` or `git add .`. Stage explicit paths.
- Group id: `/^[0-4]\.[0-9a-z]{6,14}$/`. The colour is the first digit. A new
  group takes the least-used colour, and ties go to the lowest index.
- A group is a contiguous run of ≥2 tabs with the same valid id. A run of one
  draws as a plain tab.
- Doorway: a group edge costs half a row of travel. Hold-to-group arms after
  400ms in the middle half of a tab it could group with.
- Groups never merge or nest. A collapsed group dragged by its head moves
  whole and has no hold-to-group.
- Collapsed state: `localStorage['oneterm-collapsed']`, a JSON array, every
  access in try/catch.
- `/reorder` without `groups=` behaves exactly as before. With a bad
  `groups=` it returns 400 `bad_groups` and writes nothing.
- Group colours (light / dark):
  - 0 `#3D5A80` / `#8FA8CC`
  - 1 `#7A4C70` / `#C99BBE`
  - 2 `#3B6B73` / `#86B7BE`
  - 3 `#6A5A9A` / `#A99BD6`
  - 4 `#5E6670` / `#A3ABB5`

## Review Focus

1. **An old page still open in another window** POSTs `/reorder` without
   `groups=`. Groups must survive it. (Task 2 e2e: reorder without groups
   keeps the group.)
2. **A hand-set or garbage `@oneterm_group`** (`tmux set -t … @oneterm_group 'x|~|y'`)
   must read as no group and must not shift the row's fields. (Task 2: the
   field is validated; the row delimiter is already refused for labels, and a
   group value with the delimiter is caught by the field count.)
3. **`/groups.mjs` fails to load** (old host, network blip). The rail must
   paint flat, exactly as before. (Task 3: `G` null ⇒ the flat path.)
4. **The poll repaints mid-drag** with grouped rows wrapped in `.grp`.
   `railOwed` must still defer it, and `endDrag` must still clean up. (Task 4:
   the drag reads rows via `querySelectorAll('.sess')`, and paintRail's guard
   is unchanged.)
5. **Closing the head of a collapsed group.** The next tab becomes the head
   and the group stays collapsed, because the group id, not the head, is
   what's stored. (Task 1: `railItems` after removal; Task 3: collapsed keyed
   by group id.)

---

### Task 1: `groups.mjs` and its tests

**Files:**
- Create: `groups.mjs`, `test/groups.test.mjs`
- Modify: `bin/reload.sh` (gate), `.github/workflows/tests.yml` (CI step)

**Interfaces (produced):**
- `GROUP_ID: RegExp`, `COLORS = 5`
- `validGroup(g): boolean`, `groupColor(id): 0..4 | null`
- `newGroupId(liveIds: string[], now?: number, rand?: () => number): string`
- `railItems(sessions): Array<{kind:'tab', s} | {kind:'group', id, color, members}>`
- `memberMap(sessions): Map<id, gid>`: only tabs in displayed groups
- `liveGroupIds(sessions): string[]`
- `branchGroup(parent, liveIds, now?, rand?): { group, parentNeedsIt }`
- `visibleIds(sessions, collapsed: Set): string[]`
- `dragUnit(sessions, id, collapsed): { ids: string[], whole: boolean, group: string|null }`
- `dropLayout(sessions, unit, collapsed)` returns
  `{ positions: [{gap, before, group, offset}], rows: [{id, from, to}], origin }`
- `locate(layout, c, cur, holdable: (rowIndex) => boolean)` returns `{ pos, over }`
- `resolveDrop(sessions, unit, target, now?, rand?)` returns `{ ids, groups } | null`,
  where `target` is `{ before: id|null, group: gid|null }` or `{ onto: id }`

- [ ] Write `test/groups.test.mjs` with these cases:
  - `railItems`: plain tabs; one group; a group of one drawn plain; a split
    group drawn as two runs; an invalid id ignored; closing a collapsed head
    leaves the same group id on the next tab.
  - `newGroupId`: least-used colour; ties go to the lowest index; the format
    matches `GROUP_ID` for small and real `now`.
  - `branchGroup`: a plain parent gets a new id with `parentNeedsIt`; a
    grouped parent gives its own id.
  - `dropLayout`:
    - Doorway offsets: the bottom tab of a group dragged half a row down
      lands outside; dragged up from the head at the top of the rail it
      leaves at half a row.
    - A plain tab passing a 2-member group passes join, interior, join, out.
    - A whole collapsed group gets only outside positions and skips other
      groups' interiors.
    - A collapsed group offers no inside positions to a tab.
  - `locate`: the middle half of a holdable row returns `over` and keeps `cur`;
    non-holdable snaps to the nearest position.
  - `resolveDrop`:
    - join between members
    - leave by the bottom and the top doorway
    - hold onto a plain tab makes a new group, placed after the target
    - hold onto a grouped tab joins it, placed after the target
    - hold with a whole unit returns `null`
    - moving a collapsed group keeps its id and stays contiguous
    - a tab dropped into another group's interior with `group:null` is forced to join
    - **Property check:** for every position of every unit in several
      layouts, the result has no group of one and no split group.
- [ ] Run `node test/groups.test.mjs`. It should fail, because the module is missing.
- [ ] Implement `groups.mjs`.
- [ ] Run it again. Everything should pass.
- [ ] Gate it: add a block to `bin/reload.sh` after the branching tests, and a
  CI step `node test/groups.test.mjs`.
- [ ] Commit the spec, this plan, the module, the tests and the gates.

### Task 2: Host

**Files:** Modify `server.mjs`, `test/e2e-branch.sh`

**Consumes:** `GROUP_ID`, `validGroup`, `liveGroupIds`, `branchGroup` from Task 1.

- [ ] `listSessions`:
  - add `'#{@oneterm_group}'` as the 10th field (`FIELDS = 10`)
  - destructure `group`
  - return `group: validGroup(group) ? group : null`
- [ ] `/reorder`:
  - if `groups` is present, split it on `,`
  - the length must equal the ids'; each slot must be `''` or valid. Else return `400 {error:'bad_groups'}` before writing
  - `writeOrder(ids)`
  - list sessions, and for each id whose stored group differs, run
    `tmux set-option -t … @oneterm_group <g>` or `set-option -u …`
- [ ] `/branch`: after the order write, run
  `branchGroup(parent, liveGroupIds(list))`, set the group on the branch, and
  on the parent when `parentNeedsIt`.
- [ ] Serve `/groups.mjs` from `ROOT/groups.mjs` with `text/javascript`
  (`TYPES['.mjs']`), outside `public/`, the same way the vendor files are served.
- [ ] `test/e2e-branch.sh` gains:
  - the plain-tab branch and the parent share a valid group
  - a branch of the branch has the same group
  - `/reorder` with a bad `groups=` returns 400 and changes nothing
  - `/reorder` without `groups=` keeps the group
  - `GET /groups.mjs` is served as JavaScript
- [ ] `node --check server.mjs`, then run the e2e against a second host on
  7332 started from the worktree.
- [ ] Commit.

### Task 3: Page, drawing

**Files:** Modify `public/index.html`

- [ ] CSS:
  - group tokens `--g0..--g4` in `:root` and dark
  - `.grp` (tint, 3px margin, 5px radius) with its `::before` line at `left:-7px`
  - `.grp[data-c=N]` sets `--gc`
  - `.sess .gc` chip and `.gc .mini`
  - drag preview `.dl` / `.dp`, the `.hold` target ring, and `.sess.drag-src{overflow:visible}`
- [ ] Load: `let G = null; import('/groups.mjs').then(m => { G = m; lastSig = ''; refresh() }).catch(() => {})`
- [ ] Collapsed set: load, save and prune, each in try/catch. Prune ids that no
  session carries.
- [ ] `paintRail`:
  - extract the per-session row builder into `rowEl(s, extra)`
  - with `G`, render `railItems`: tabs plain; groups in `.grp` with members,
    or the head alone when collapsed
  - the head gets the chip: `count ▾`, or `+n` with up to 4 mini dots and `▸`
  - a collapsed head takes the group's wash and bar classes
  - when `active` changed since the last paint and sits in a collapsed group,
    expand it first
- [ ] The chip's click toggles collapse and stops propagation. `beginDrag` and
  `ondblclick` ignore `.gc`.
- [ ] The `refresh` signature includes `s.group`.
- [ ] Parse check: `bash bin/reload.sh` gate section (inline-script parse) via
  the same node one-liner.
- [ ] Commit.

### Task 4: Page, dragging

**Files:** Modify `public/index.html`

- [ ] `beginDrag`:
  - rows = visible `.sess`
  - `unit = G.dragUnit(sessions, id, collapsed)`
  - `layout = G.dropLayout(...)`
  - `cur = layout.origin`
  - `pitch` = row height + 1
- [ ] `onDragMove`:
  - `c = layout.positions[layout.origin].offset + dy/pitch`
  - `{pos, over} = G.locate(layout, c, cur, holdable)`
  - the gap index is `positions[pos].gap`
  - the preview pill and line come from `positions[pos].group` against `unit.group`
  - the hold timer is 400ms, restarted when the pointer moves more than 6px; when armed, the target gets `.hold`
- [ ] `layoutGap`: shift by the held row's height+1, using the gap index.
- [ ] `endDrag`:
  - if armed, target `{onto}`; else `{before, group}` from the position
  - `G.resolveDrop` gives the layout; apply it optimistically to `sessions` (order and group)
  - if the drop joined a collapsed group, expand it
  - POST `/reorder?ids=…&groups=…`
- [ ] Without `G`, the old path stays as it is.
- [ ] Parse check, then commit.

### Task 5: Verify in the real app, then document

- [ ] Start a host from the worktree on 7332 and drive it in Chrome:
  - branch twice
  - collapse and expand
  - a waiting tab in a collapsed group
  - drag out through both doorways and back in
  - hold-to-group on a plain tab and on a grouped tab
  - move a collapsed group
  - dark mode
- [ ] Fix what turns up.
- [ ] README "What it does" gets one bullet. Set the spec status to "built".
- [ ] Final review of the whole branch, then merge to main.
