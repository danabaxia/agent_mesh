# A2A Task Board view — the mesh's ticket board in the dashboard

**Date:** 2026-06-22
**Status:** Design (pending review)
**Builds on:** the mesh task board ([src/board/*](../../../src/board/), spec 2026-06-15-mesh-task-handoff-design.md) — the durable A2A task-handoff system this view surfaces.

## Problem

The mesh has an internal "Jira" already: durable A2A tickets (`create_task_for_peer` → a peer
picks them up and advances them `assigned → acknowledged → in-progress → done`), stored as
one JSON per task under `<mesh-root>/mesh/board/tasks/`. But there is **no way to see the
board** — no dashboard surface lists these tickets. The owner can't tell, at a glance, what
work is queued, in flight, or done across the mesh.

## Goal

A **standalone, read-only Task Board view** — a Jira-style kanban of the A2A tickets — on the
**desktop dashboard** (a new top-level view) and the **phone `/m` PWA** (a new Tasks tab).
Columns by state; click a card to read the full ticket.

### Decisions (owner-confirmed)

1. **Read-only display.** No create/advance/reassign from the dashboard — tasks are advanced
   only by the assignee agent with framework-set identity (existing board invariant); the
   dashboard is a read-only monitor. (Task *creation* already exists, tap-gated, via the
   concierge — out of scope here.)
2. **Desktop dashboard standalone view + phone `/m` Tasks tab.**
3. **Kanban columns by state**: `assigned → acknowledged → in-progress → done`.

### Non-goals (YAGNI)

- No drag-to-move / status changes / reassignment (would violate the board's
  assignee-only, framework-set-identity invariant).
- No task creation here (the concierge's Confirm-gated `assign_task` already covers that).
- No new persistence — read the existing board store.

## Architecture

```
 <mesh-root>/mesh/board/tasks/*.json
        │  listTasks(meshRoot)   (src/board/store.js — existing)
        ▼
 GET /api/board/tasks  →  { tasks: [...], summary: { total, assigned, acknowledged, inProgress, done } }
        │  (read-only, same-origin + token gated like every /api/* route)
        ▼
 buildTaskBoard(tasks)  (pure, src/dashboard/public/tasks-model.js)
        │  → { columns: [{ state, label, cards: [{ id, title, from, to, ageMs, hasResult }] }], summary }
        ├──────────────▶ Desktop: board2.html #view-tasks (kanban columns + card → detail panel)
        └──────────────▶ Phone /m: Tasks tab (stacked columns; card → detail)
```

### 1. Read route — `GET /api/board/tasks`

In [src/dashboard/server.js](../../../src/dashboard/server.js), beside the other read routes:

```js
if (pathname === '/api/board/tasks' && req.method === 'GET') {
  const tasks = await listTasks(meshRoot);     // src/board/store.js; tolerant ([] if no dir)
  sendJson(res, 200, { ok: true, tasks });
  return;
}
```

`listTasks` already returns `[]` for a missing board dir (tolerant). Register
`/^\/api\/board\/tasks$/` in [src/dashboard/routes-manifest.js](../../../src/dashboard/routes-manifest.js).
Auth/host gating is automatic (same-origin gate + token, like all `/api/*`). The route returns
the **raw tasks**; grouping/summary is computed in the pure view-model so it's testable and
shared between desktop + phone.

### 2. Pure view-model — `src/dashboard/public/tasks-model.js`

```js
export const TASK_COLUMNS = [
  { state: 'assigned',     label: 'Assigned' },
  { state: 'acknowledged', label: 'Acknowledged' },
  { state: 'in-progress',  label: 'In progress' },
  { state: 'done',         label: 'Done' },
];

// tasks → { columns:[{state,label,cards:[card]}], summary:{total, <state>:n} }
// card = { id, title, from, to, state, ageMs, hasResult }
// ageMs from the last history entry's `at` (fallback created_at), relative to `now`.
export function buildTaskBoard(tasks, { now = Date.now() } = {}) { /* group by state in
  canonical order; unknown states bucket under their own column appended after the four;
  newest-first within a column */ }
```

Pure, no DOM/fetch. Reused by both surfaces. A compact `card` shape keeps the list cheap; the
**detail** (objective/requirements/context/pointers/result/history) is read from the full task
object the route already returned (kept client-side), so no second fetch.

### 3. Desktop view — `board2.html` `#view-tasks` + `board2.js`

- New top-level view section `<div class="view" id="view-tasks">` and a nav button
  (`data-topview="tasks"`, e.g. "🎫 Tasks") wired with the existing open/close view-switch
  pattern (like `view-graph`/`view-health`).
- On open: `fetch('/api/board/tasks')` → `buildTaskBoard` → render **four columns** with a
  count badge each; each card shows title, `from → to`, relative age, and a ✓ if it has a
  result. Clicking a card opens a **detail panel** (reusing the existing net/detail panel
  pattern) showing the full ticket: objective, requirements, context, pointers, the **history
  timeline** (state · when · by), and the result if done.
- Refreshes with the dashboard's existing poll/refresh cycle. New CSS in a small
  `tasks-view.css` (columns layout, card, state colors) following `graph-view.css` conventions.

### 4. Phone `/m` Tasks tab — `src/dashboard/public/mobile/*`

- A 4th tab (Chat / Status / 🚨 Alerts / 🎫 Tasks) + a `view-tasks` section.
- On tab select: `fetch('/api/board/tasks', { headers: authHeaders() })` → `buildTaskBoard` →
  render **stacked, collapsible state sections** (mobile-friendly kanban: one column per
  state, each a card list) reusing the existing `.card`/`.metric` styling. Tapping a card
  expands its detail inline (objective + history). Same pure model as desktop.

## Data flow

dashboard/phone → `GET /api/board/tasks` → `{tasks}` → `buildTaskBoard(tasks)` →
columns rendered; click/tap a card → detail from the in-memory task object. Read-only
throughout; no writes.

## Error handling

- No board dir / empty → `listTasks` returns `[]` → all columns empty, a friendly "No tasks
  yet" state. Never 500 for the empty case.
- Unexpected read error → route returns `200 {ok:true, tasks:[]}` is wrong for real errors;
  instead wrap and return `500 {ok:false,error}` only on a genuine throw, and the UI shows a
  load-error note (consistent with the other views).
- Malformed task JSON: `listTasks` already filters unreadable files (returns the readable
  ones); the model tolerates missing fields (defaults) so one bad card can't break the board.

## Security / invariants

- **Read-only** — no mutation surface; the route only reads. The board's assignee-only,
  framework-set-identity advancement invariant is untouched.
- Same-origin + token gate applies (every `/api/*`); phone uses the existing
  `X-Dashboard-Token` header path. No new exposure; dashboard stays `127.0.0.1` + tailnet.
- Tasks may contain free-text briefs (data) — rendered as **escaped text**, never HTML, so a
  task brief can't inject markup (reuse the existing `escapeHtml`).

## Testing (hermetic, `node --test`)

- **tasks-model** (pure): groups by state in canonical order; counts in `summary`; `ageMs`
  from last history entry (fallback created_at); newest-first ordering; tolerates
  missing/extra fields; unknown state → its own trailing column; empty input → empty columns.
- **route** `test/board-tasks-route.test.js`: seed a couple tasks via the board store, `GET
  /api/board/tasks` (header-token) → returns them; missing board → `{ok:true,tasks:[]}`; auth
  required (no token → 403).
- **phone Tasks render** (zero-dep DOM helpers in the frontend-qa tier): the pure model →
  card/column rendering; escaped briefs.
- **routes-manifest** equivalence test stays green (new pattern registered).

## File-level summary

| Unit | File | New/changed |
| --- | --- | --- |
| Read route | `src/dashboard/server.js` (+ `listTasks` import) | changed |
| Route manifest | `src/dashboard/routes-manifest.js` | changed |
| Pure model | `src/dashboard/public/tasks-model.js` | new |
| Desktop view | `src/dashboard/public/board2.html`, `board2.js`, `tasks-view.css` | new + changed |
| Phone tab | `src/dashboard/public/mobile/{index.html,app.js,app.css}` | changed |
| Tests | `test/tasks-model.test.js`, `test/board-tasks-route.test.js`, mobile PWA test | new + changed |
| Docs | this spec; CLAUDE.md note | new + changed |
