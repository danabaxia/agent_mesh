# A2A Task Board View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only, Jira-style kanban view of the mesh's A2A task tickets — a new standalone view on the desktop dashboard and a Tasks tab on the phone `/m` PWA — grouped by state (assigned → acknowledged → in-progress → done).

**Architecture:** A new `GET /api/board/tasks` route reads the existing board store (`listTasks`); a pure, shared `buildTaskBoard(tasks)` view-model groups tasks into state columns; the desktop (`tasks-view.js`) and phone (`app.js`) both render from that model. Read-only — no mutation surface.

**Tech Stack:** Node ≥20, zero-dep `node --test`, ESM, vanilla browser JS. Reuses `src/board/store.js` (`listTasks`), the dashboard route/view/pure-model patterns, and `escapeHtml`.

## Global Constraints

- Node >= 20; **no new dependencies**.
- **Read-only**: the route only reads; no create/advance/reassign. The board's assignee-only, framework-set-identity advancement invariant is untouched.
- Task briefs are **escaped text**, never HTML (no injection from a task brief).
- Same-origin + token gate applies to every `/api/*` route (automatic); phone uses the `X-Dashboard-Token` header path.
- Tests hermetic (`node --test`); full-suite gate: `node run-all-tests.mjs`.
- Canonical state order: `['assigned','acknowledged','in-progress','done']` (from `src/board/task-state.js`).

## File Structure

- `src/dashboard/public/tasks-model.js` — pure `buildTaskBoard` (+ `TASK_COLUMNS`, `relAge`)
- `src/dashboard/server.js` — `GET /api/board/tasks` (+ `listTasks` import)
- `src/dashboard/routes-manifest.js` — register the route pattern
- `src/dashboard/public/tasks-view.js` — desktop `renderTasksView(el)` (fetch + render + detail)
- `src/dashboard/public/board2.html` / `board2.js` — `#view-tasks` section + nav button + open/close/dispatch
- `src/dashboard/public/tasks-view.css` — columns/cards styling
- `src/dashboard/public/mobile/{index.html,app.js,app.css}` — phone Tasks tab
- `test/tasks-model.test.js`, `test/board-tasks-route.test.js`, `test/mobile-pwa.test.js` (extend)

---

### Task 1: Pure view-model — `tasks-model.js`

**Files:**
- Create: `src/dashboard/public/tasks-model.js`
- Test: `test/tasks-model.test.js`

**Interfaces:**
- Produces:
  - `TASK_COLUMNS: [{state, label}]` in canonical order.
  - `buildTaskBoard(tasks, { now }) -> { columns: [{state, label, cards: Card[]}], summary: {total, [state]: n} }`
    where `Card = { id, title, from, to, state, ageMs, hasResult }`, newest-first within a column.
  - `relAge(ms) -> string` compact ("3m"/"2h"/"1d"/"just now").

- [ ] **Step 1: Write the failing test**

```javascript
// test/tasks-model.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskBoard, TASK_COLUMNS, relAge } from '../src/dashboard/public/tasks-model.js';

const NOW = Date.parse('2026-06-22T12:00:00Z');
const mk = (id, state, at) => ({ id, from: 'analyst', to: 'tester', title: `T-${id}`, state,
  created_at: at, history: [{ state, at, by: 'analyst' }], result: state === 'done' ? 'ok' : null });

test('TASK_COLUMNS is the canonical order', () => {
  assert.deepEqual(TASK_COLUMNS.map((c) => c.state), ['assigned', 'acknowledged', 'in-progress', 'done']);
});

test('groups by state, counts in summary, newest-first within a column', () => {
  const b = buildTaskBoard([
    mk('1', 'assigned', '2026-06-22T10:00:00Z'),
    mk('2', 'assigned', '2026-06-22T11:00:00Z'),
    mk('3', 'in-progress', '2026-06-22T09:00:00Z'),
    mk('4', 'done', '2026-06-21T12:00:00Z'),
  ], { now: NOW });
  const col = (s) => b.columns.find((c) => c.state === s);
  assert.deepEqual(col('assigned').cards.map((c) => c.id), ['2', '1']);   // newest first
  assert.equal(col('in-progress').cards[0].ageMs, 3 * 3600 * 1000);
  assert.equal(col('done').cards[0].hasResult, true);
  assert.equal(b.summary.total, 4);
  assert.equal(b.summary.assigned, 2);
  assert.equal(b.summary['in-progress'], 1);
});

test('tolerates missing fields + unknown state gets a trailing column', () => {
  const b = buildTaskBoard([{ id: 'x', state: 'weird' }, {}], { now: NOW });
  assert.ok(b.columns.find((c) => c.state === 'weird'), 'unknown state column appended');
  // a task with no state is bucketed but never throws
  assert.equal(b.summary.total, 2);
});

test('relAge is compact', () => {
  assert.equal(relAge(30 * 1000), 'just now');
  assert.equal(relAge(5 * 60 * 1000), '5m');
  assert.equal(relAge(3 * 3600 * 1000), '3h');
  assert.equal(relAge(2 * 86400 * 1000), '2d');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/tasks-model.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```javascript
// src/dashboard/public/tasks-model.js
// Pure view-model for the A2A Task Board. No DOM, no fetch. Shared by desktop + phone.
export const TASK_COLUMNS = [
  { state: 'assigned',     label: 'Assigned' },
  { state: 'acknowledged', label: 'Acknowledged' },
  { state: 'in-progress',  label: 'In progress' },
  { state: 'done',         label: 'Done' },
];
const ORDER = TASK_COLUMNS.map((c) => c.state);

export function relAge(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function lastAt(task) {
  const h = Array.isArray(task?.history) ? task.history : [];
  return h.length ? h[h.length - 1]?.at : (task?.created_at ?? null);
}

function toCard(task, now) {
  const at = Date.parse(lastAt(task) ?? '');
  return {
    id: task?.id ?? '(no id)',
    title: task?.title ?? '(untitled)',
    from: task?.from ?? '?',
    to: task?.to ?? '?',
    state: task?.state ?? 'unknown',
    ageMs: Number.isFinite(at) ? Math.max(0, now - at) : 0,
    hasResult: task?.result != null && task.result !== '',
  };
}

export function buildTaskBoard(tasks, { now = Date.now() } = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  const cards = list.map((t) => toCard(t, now));
  const summary = { total: cards.length };
  // start with the four canonical columns (always shown, even if empty)
  const colMap = new Map(TASK_COLUMNS.map((c) => [c.state, { ...c, cards: [] }]));
  for (const card of cards) {
    if (!colMap.has(card.state)) colMap.set(card.state, { state: card.state, label: card.state, cards: [] });
    colMap.get(card.state).cards.push(card);
    summary[card.state] = (summary[card.state] ?? 0) + 1;
  }
  // newest-first within each column (largest... smallest by recency => smallest ageMs first)
  for (const col of colMap.values()) col.cards.sort((a, b) => a.ageMs - b.ageMs);
  // canonical columns first (in order), then any unknown-state columns appended
  const ordered = [...ORDER.map((s) => colMap.get(s)), ...[...colMap.values()].filter((c) => !ORDER.includes(c.state))];
  return { columns: ordered, summary };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/tasks-model.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/public/tasks-model.js test/tasks-model.test.js
git commit -m "feat(taskboard): pure view-model — group A2A tickets into state columns"
```

---

### Task 2: Read route — `GET /api/board/tasks`

**Files:**
- Modify: `src/dashboard/server.js` (import `listTasks`; add route)
- Modify: `src/dashboard/routes-manifest.js`
- Test: `test/board-tasks-route.test.js`

**Interfaces:**
- Consumes: `listTasks(meshRoot)` from `src/board/store.js` (returns `[]` for a missing board dir).
- Produces: `GET /api/board/tasks -> { ok: true, tasks: Task[] }` (raw tasks; grouping is client-side).

- [ ] **Step 1: Write the failing test**

```javascript
// test/board-tasks-route.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createDashboardServer } from '../src/dashboard/server.js';
import { initMesh } from '../src/builder/init-mesh.js';
import { createTask } from '../src/board/store.js';

function raw({ port, path, headers = {} }) {
  return new Promise((res, rej) => {
    const r = httpRequest({ hostname: '127.0.0.1', port, path, method: 'GET', headers }, (x) => {
      let d = ''; x.on('data', (c) => d += c); x.on('end', () => res({ status: x.statusCode, body: d }));
    });
    r.on('error', rej); r.end();
  });
}

test('GET /api/board/tasks returns the board tickets (header-token auth)', async () => {
  const meshRoot = await mkdtemp(join(tmpdir(), 'bt-'));
  await initMesh(meshRoot);
  await createTask(meshRoot, { from: 'analyst', to: 'tester', title: 'Run suite', objective: 'green', requirements: 'all pass' });
  const srv = createDashboardServer({ meshRoot, port: 0 });
  await srv.start();
  const port = new URL(srv.url).port, token = srv.token;
  try {
    const res = await raw({ port, path: '/api/board/tasks', headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', 'X-Dashboard-Token': token } });
    assert.equal(res.status, 200);
    const j = JSON.parse(res.body);
    assert.equal(j.ok, true);
    assert.equal(j.tasks.length, 1);
    assert.equal(j.tasks[0].title, 'Run suite');
    assert.equal(j.tasks[0].state, 'assigned');
  } finally { await srv.close(); }
});

test('empty board → { ok:true, tasks:[] }; missing token → 403', async () => {
  const meshRoot = await mkdtemp(join(tmpdir(), 'bt-'));
  await initMesh(meshRoot);
  const srv = createDashboardServer({ meshRoot, port: 0 });
  await srv.start();
  const port = new URL(srv.url).port, token = srv.token;
  try {
    const ok = await raw({ port, path: '/api/board/tasks', headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', 'X-Dashboard-Token': token } });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body), { ok: true, tasks: [] });
    const no = await raw({ port, path: '/api/board/tasks', headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' } });
    assert.equal(no.status, 403);
  } finally { await srv.close(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/board-tasks-route.test.js`
Expected: FAIL — route 404 (not yet added).

- [ ] **Step 3: Implement the route**

In `src/dashboard/server.js`, add the import near the other `../board`/data imports:
```javascript
import { listTasks } from '../board/store.js';
```
Add the route beside the other read routes (e.g. right after the `/api/concierge/alerts` block):
```javascript
if (pathname === '/api/board/tasks' && req.method === 'GET') {
  const tasks = await listTasks(meshRoot);   // tolerant: [] when no board dir
  sendJson(res, 200, { ok: true, tasks });
  return;
}
```
In `src/dashboard/routes-manifest.js`, add to `ROUTE_PATTERNS`:
```javascript
/^\/api\/board\/tasks$/,       // GET /api/board/tasks  (A2A task board)
```

- [ ] **Step 4: Run tests**

Run: `node --test test/board-tasks-route.test.js test/deadcode-routes-equivalence.test.js`
Expected: PASS both.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/server.js src/dashboard/routes-manifest.js test/board-tasks-route.test.js
git commit -m "feat(taskboard): GET /api/board/tasks (read-only board store)"
```

---

### Task 3: Desktop view — `tasks-view.js` + board2 wiring + CSS

**Files:**
- Create: `src/dashboard/public/tasks-view.js`, `src/dashboard/public/tasks-view.css`
- Modify: `src/dashboard/public/board2.html` (nav button, `#view-tasks` section, css link), `src/dashboard/public/board2.js` (import + open/close + dispatch)

**Interfaces:**
- Consumes: `buildTaskBoard`, `relAge` (Task 1); `GET /api/board/tasks` (Task 2).
- Produces: `renderTasksView(el)` — fetches, renders kanban columns + click-to-detail.

- [ ] **Step 1: Create `tasks-view.js`**

```javascript
// src/dashboard/public/tasks-view.js — read-only A2A task board (kanban by state).
import { buildTaskBoard, relAge } from '/tasks-model.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function renderTasksView(el) {
  el.innerHTML = '<div class="tv-wrap"><div class="tv-loading">Loading tasks…</div></div>';
  let tasks = [];
  try {
    const r = await fetch('/api/board/tasks');
    if (!r.ok) throw new Error(`${r.status}`);
    tasks = (await r.json()).tasks ?? [];
  } catch {
    el.innerHTML = '<div class="tv-wrap"><div class="tv-loading">Could not load the board.</div></div>';
    return;
  }
  const board = buildTaskBoard(tasks);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  el.innerHTML = `
    <div class="tv-head"><h2>🎫 Task board <span class="tv-sub">${board.summary.total} ticket(s)</span></h2></div>
    <div class="tv-cols">
      ${board.columns.map((c) => `
        <div class="tv-col" data-state="${esc(c.state)}">
          <div class="tv-colhead">${esc(c.label)} <span class="tv-count">${c.cards.length}</span></div>
          <div class="tv-cards">
            ${c.cards.map((card) => `
              <div class="tv-card" data-id="${esc(card.id)}">
                <div class="tv-title">${esc(card.title)}</div>
                <div class="tv-meta"><span>${esc(card.from)} → ${esc(card.to)}</span><span>${esc(relAge(card.ageMs))}${card.hasResult ? ' · ✓' : ''}</span></div>
              </div>`).join('') || '<div class="tv-empty">—</div>'}
          </div>
        </div>`).join('')}
    </div>
    <div class="tv-detail" hidden></div>`;
  el.querySelectorAll('.tv-card').forEach((cardEl) => {
    cardEl.onclick = () => showDetail(el.querySelector('.tv-detail'), byId.get(cardEl.dataset.id));
  });
}

function showDetail(panel, task) {
  if (!task) return;
  const hist = (Array.isArray(task.history) ? task.history : [])
    .map((h) => `<li><b>${esc(h.state)}</b> · ${esc(h.at)}${h.by ? ` · ${esc(h.by)}` : ''}</li>`).join('');
  const field = (label, v) => v ? `<div class="tv-field"><span>${esc(label)}</span><p>${esc(v)}</p></div>` : '';
  panel.hidden = false;
  panel.innerHTML = `
    <div class="tv-dhead"><b>${esc(task.title)}</b> <span class="tv-sub">${esc(task.id)} · ${esc(task.from)} → ${esc(task.to)} · ${esc(task.state)}</span>
      <button class="tv-close" type="button">×</button></div>
    ${field('Objective', task.objective)}
    ${field('Requirements', task.requirements)}
    ${field('Context', task.context)}
    ${field('Pointers', task.pointers)}
    ${task.result ? field('Result', task.result) : ''}
    <div class="tv-field"><span>History</span><ul class="tv-hist">${hist || '<li>—</li>'}</ul></div>`;
  panel.querySelector('.tv-close').onclick = () => { panel.hidden = true; };
}
```

- [ ] **Step 2: Create `tasks-view.css`**

```css
/* tasks-view.css — A2A task board (kanban) */
#view-tasks { padding: 18px 22px; overflow: auto; }
#view-tasks .tv-head h2 { margin: 0 0 14px; font-size: 18px; }
#view-tasks .tv-sub { color: #8a99b0; font-size: 13px; font-weight: 400; }
#view-tasks .tv-cols { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; align-items: start; }
#view-tasks .tv-col { background: #f7f5ef; border: 1px solid #e4ddca; border-radius: 12px; padding: 10px; min-width: 0; }
#view-tasks .tv-colhead { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: .4px; margin-bottom: 8px; display: flex; justify-content: space-between; }
#view-tasks .tv-count { color: #8a99b0; }
#view-tasks .tv-card { background: #fff; border: 1px solid #e4ddca; border-radius: 9px; padding: 9px 11px; margin-bottom: 8px; cursor: pointer; }
#view-tasks .tv-card:hover { border-color: #2bb89a; }
#view-tasks .tv-title { font-weight: 600; font-size: 14px; margin-bottom: 5px; overflow-wrap: anywhere; }
#view-tasks .tv-meta { display: flex; justify-content: space-between; gap: 8px; color: #8a99b0; font-size: 12px; }
#view-tasks .tv-empty { color: #b9b09a; text-align: center; padding: 6px; }
#view-tasks .tv-detail { margin-top: 16px; background: #fff; border: 1px solid #e4ddca; border-radius: 12px; padding: 14px 16px; }
#view-tasks .tv-dhead { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
#view-tasks .tv-close { margin-left: auto; border: none; background: none; font-size: 20px; cursor: pointer; color: #8a99b0; }
#view-tasks .tv-field { margin: 8px 0; } #view-tasks .tv-field span { font-size: 12px; color: #8a99b0; text-transform: uppercase; letter-spacing: .4px; }
#view-tasks .tv-field p { margin: 3px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
#view-tasks .tv-hist { margin: 4px 0 0; padding-left: 18px; font-size: 13px; color: #4a5468; }
```

- [ ] **Step 3: Wire board2.html**

Add the css link in `<head>` (beside the other view css):
```html
<link rel="stylesheet" href="/tasks-view.css" />
```
Add the nav button next to the graph/health buttons (line ~27):
```html
<button class="hbtn" data-topview="tasks" title="A2A task board — the mesh's ticket system">🎫 tasks</button>
```
Add the view section next to `#view-health` (line ~90):
```html
<div class="view" id="view-tasks"></div>
```

- [ ] **Step 4: Wire board2.js**

Add the import (beside the other view imports, line ~8):
```javascript
import { renderTasksView } from '/tasks-view.js';
```
Add open/close (beside `openHealthView`/`closeHealthView`):
```javascript
function openTasksView() {
  document.querySelector('#view-board').classList.remove('on');
  document.querySelector('#view-ws').classList.remove('on');
  document.querySelector('#view-graph').classList.remove('on');
  document.querySelector('#view-health').classList.remove('on');
  document.querySelector('#view-tasks').classList.add('on');
  renderTasksView(document.querySelector('#view-tasks'));
}
function closeTasksView() {
  document.querySelector('#view-tasks').classList.remove('on');
  document.querySelector('#view-board').classList.add('on');
}
```
In the `data-topview` dispatch block (line ~157), add `closeTasksView()` to the idempotent-close line and a case:
```javascript
closeGraphView(); closeHealthView(); closeTasksView();
if (v === 'graph') openGraphView();
else if (v === 'health') openHealthView();
else if (v === 'tasks') openTasksView();
```

- [ ] **Step 5: Manually verify (no test for static wiring) + commit**

Run: `node -e "import('./src/dashboard/public/tasks-model.js').then(()=>console.log('model ok'))"` (sanity; the view JS is browser-only).
Verify locally if desired: start the dashboard, open `/`, click **🎫 tasks**, confirm columns render.

```bash
git add src/dashboard/public/tasks-view.js src/dashboard/public/tasks-view.css src/dashboard/public/board2.html src/dashboard/public/board2.js
git commit -m "feat(taskboard): desktop Task Board view (kanban + ticket detail)"
```

---

### Task 4: Phone `/m` Tasks tab

**Files:**
- Modify: `src/dashboard/public/mobile/index.html` (tab + view), `app.js` (render), `app.css` (minor)
- Test: `test/mobile-pwa.test.js` (extend)

**Interfaces:**
- Consumes: `buildTaskBoard` (Task 1, imported into app.js); `GET /api/board/tasks`.
- Produces: `summarizeTaskColumns(board) -> [{title, rows:[{label,value,cls}]}]` (pure, exported) — one card per state column, each row a ticket.

- [ ] **Step 1: Write the failing test**

```javascript
// add to test/mobile-pwa.test.js (import summarizeTaskColumns alongside the others)
import { summarizeTaskColumns } from '../src/dashboard/public/mobile/app.js';
import { buildTaskBoard } from '../src/dashboard/public/tasks-model.js';

test('summarizeTaskColumns → one card per non-empty state with ticket rows', () => {
  const board = buildTaskBoard([
    { id: 'a-b-1', from: 'a', to: 'b', title: 'Run suite', state: 'assigned', history: [] },
    { id: 'a-b-2', from: 'a', to: 'b', title: 'Done thing', state: 'done', result: 'ok', history: [] },
  ]);
  const cards = summarizeTaskColumns(board);
  const assigned = cards.find((c) => c.title.startsWith('Assigned'));
  assert.ok(assigned.rows.some((r) => r.label.includes('Run suite')));
  const done = cards.find((c) => c.title.startsWith('Done'));
  assert.ok(done);
  // empty input → a single "no tasks" card
  assert.equal(summarizeTaskColumns(buildTaskBoard([]))[0].rows[0].value, '—');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/mobile-pwa.test.js`
Expected: FAIL — `summarizeTaskColumns` not exported.

- [ ] **Step 3: Implement in `mobile/app.js`**

**Do NOT add a top-level `import … from '/tasks-model.js'`** — the node test imports `app.js`, and node cannot resolve a browser-absolute path. Keep the pure export import-free, and use a **browser-only dynamic import** inside `loadTasks`.

Add the pure helper (near `summarizeAlerts`) — takes an already-built `board`, formats age locally (no import):
```javascript
// One card per non-empty column; each ticket a row (label "title · from→to", value age).
export function summarizeTaskColumns(board) {
  const fmtAge = (ms) => { const s = Math.max(0, Math.round((ms || 0) / 1000));
    return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s/60)}m` : s < 86400 ? `${Math.round(s/3600)}h` : `${Math.round(s/86400)}d`; };
  const cols = (board?.columns ?? []).filter((c) => c.cards.length);
  if (!cols.length) return [{ title: 'Tasks', rows: [{ label: 'No tasks yet', value: '—', cls: 'muted' }] }];
  return cols.map((c) => ({
    title: `${c.label} (${c.cards.length})`,
    rows: c.cards.map((card) => ({ label: `${card.title} · ${card.from}→${card.to}`, value: fmtAge(card.ageMs) + (card.hasResult ? ' ✓' : ''), cls: '' })),
  }));
}
```
In `mount()`: add a `tasks` tab + a `view-tasks` toggle + `loadTasks()` (dynamic import — only runs in the browser, never during the node test):
```javascript
const loadTasks = async () => {
  const box = $('tasks');
  box.innerHTML = '<div class="card muted">Loading…</div>';
  const { buildTaskBoard } = await import('/tasks-model.js');   // browser-only; absolute path served by the dashboard
  const data = await get('/api/board/tasks');
  renderCards(box, summarizeTaskColumns(buildTaskBoard(data?.tasks ?? [])));
};
```
Wire it in the tab `onclick` (add `$('view-tasks').classList.toggle('active', view === 'tasks'); if (view === 'tasks') loadTasks();`) and the `$('refresh')` handler.

- [ ] **Step 4: Wire `mobile/index.html`**

Add the view section (after `#view-alerts`):
```html
<section id="view-tasks" class="view"><div id="tasks" class="status"></div></section>
```
Add the tab button (after the Alerts tab):
```html
<button class="tab" data-view="tasks">🎫 Tasks</button>
```

- [ ] **Step 5: Run tests + commit**

Run: `node --test test/mobile-pwa.test.js`
Expected: PASS.

```bash
git add src/dashboard/public/mobile/ test/mobile-pwa.test.js
git commit -m "feat(taskboard): phone /m Tasks tab (kanban by state)"
```

---

### Task 5: Full-suite gate, docs, PR

**Files:**
- Modify: `CLAUDE.md` (one-line note)

- [ ] **Step 1: Full suite**

Run: `node run-all-tests.mjs`
Expected: all green. Fix any regression (esp. `deadcode-routes-equivalence.test.js`).

- [ ] **Step 2: CLAUDE.md note**

Add one line near the dashboard/board notes: the A2A Task Board view — read-only kanban of `mesh/board/tasks` via `GET /api/board/tasks` + pure `tasks-model.js`, desktop `#view-tasks` + phone `/m` Tasks tab. Reference this spec.

- [ ] **Step 3: Commit + PR**

```bash
git add CLAUDE.md
git commit -m "docs(taskboard): note the A2A Task Board view"
```
Open a PR; let CI go green; squash-merge. deploy-sync ships it; verify on the desktop dashboard (🎫 tasks) and phone (`/m` Tasks tab) — columns render, click a card → detail.

---

## Self-Review

**Spec coverage:** §route → Task 2; §pure model → Task 1; §desktop view → Task 3; §phone tab → Task 4; read-only (no mutation route) → Tasks 2–4; escaped briefs → Task 3 (`esc`) + Task 4 (renderCards uses escapeHtml); tests → each task. All spec sections covered.

**Placeholder scan:** none — every code step has complete code; commands have expected output.

**Type consistency:** `buildTaskBoard(tasks,{now}) → {columns:[{state,label,cards}],summary}` (T1) consumed by `tasks-view.js` (T3) and `summarizeTaskColumns(board)` (T4); `relAge(ms)` (T1) used in T3 + T4; `Card{id,title,from,to,state,ageMs,hasResult}` consistent across model + views; route returns `{ok,tasks}` (T2) consumed by both views. Consistent.
