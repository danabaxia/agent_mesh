# Orchestrator-driven Board Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A phone-initiated A2A board ticket is autonomously picked up by the orchestrator (team lead), worked by a coordinated specialist team (conductor workflow + parallel fan-out, ask-mode), resolved to `done` with a synthesized result, and shown updating live on both the phone and desktop dashboards.

**Architecture:** Mostly wiring + prompts: the orchestrator gets team `peers` + a daemon-scheduled `board-drive` delegate job + a team-lead persona; the concierge routes "work" tasks to the orchestrator; the desktop Task Board re-renders on the existing refresh loop and the phone polls its active data tab. No new code modules, no swarm runtime, no new HTTP route.

**Tech Stack:** Node ≥20, zero-dep `node --test`, ESM, vanilla browser JS. Reuses `agentmesh_peerbridge` (`delegate_to_peer`/`fanOutToPeers`/`list_my_tasks`/`update_my_task`), the scheduler `delegate` job, the Task Board (`/api/board/tasks` + `tasks-view.js` + phone Tasks tab), and `doctor` wiring.

## Global Constraints

- Node >= 20; **no new dependencies**.
- **Ask-only end to end**: the orchestrator delegates `ask`; specialists work `ask` (read-only). No `do`-mode board work this round.
- **Board invariant intact**: the orchestrator advances only its **own** ticket (it is the `to`); `from`/`to`/`id`/timestamps are framework-set; never advance another agent's ticket.
- **Agent-driven**: the daemon only *triggers* the orchestrator on a schedule; the reasoning/coordination is the agent's.
- **Conductor workflow + parallel fan-out** (owner-chosen), NOT a swarm: dependency-ordered stages + `fanOutToPeers` for independent sub-questions.
- Dashboard stays `127.0.0.1` + token + tailnet; auto-refresh is client polling of existing gated read routes.
- Tests hermetic (`node --test`); full-suite gate: `node run-all-tests.mjs`.

## File Structure

- `dev-mesh/mesh.json` — orchestrator `peers` = the team
- `dev-mesh/orchestrator/.agent/schedule.json` — add the `board-drive` delegate job
- `dev-mesh/orchestrator/AGENT.md` — team-lead persona (data)
- `dev-mesh/concierge/AGENT.md` — route "work" tasks → `assign_task` peer `orchestrator`
- `src/dashboard/public/board2.js` — re-render `#view-tasks` in `refresh()`
- `src/dashboard/public/mobile/app.js` — `pickPoll(view)` + visibility-aware poll of the active data tab
- `test/dev-mesh-agents.test.js`, `test/orchestrator-board-wiring.test.js`, `test/mobile-pwa.test.js`

---

### Task 1: Orchestrator wiring — team peers + board-drive job + persona

**Files:**
- Modify: `dev-mesh/mesh.json`, `dev-mesh/orchestrator/.agent/schedule.json`, `dev-mesh/orchestrator/AGENT.md`
- Test: `test/orchestrator-board-wiring.test.js`, `test/dev-mesh-agents.test.js`

**Interfaces:**
- Produces: orchestrator with `peers` = `[analyst, tester, triager, coder, reviewer, curator, security, maintainer]`, a `board-drive` delegate job, and a team-lead persona; `doctor` then wires its `registry.json` peers + `agentmesh_peerbridge`.

- [ ] **Step 1: Write the failing test**

```javascript
// test/orchestrator-board-wiring.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('orchestrator is wired as the board team lead', () => {
  const m = JSON.parse(readFileSync(join('dev-mesh', 'mesh.json'), 'utf8'));
  const o = m.agents.find((a) => a.name === 'orchestrator');
  assert.ok(o, 'orchestrator in mesh.json');
  for (const p of ['analyst', 'coder', 'tester', 'reviewer']) assert.ok(o.peers.includes(p), `team peer ${p}`);
  assert.deepEqual(o.enabledModes, ['ask']);   // still ask-only
});

test('orchestrator has the board-drive delegate job', () => {
  const s = JSON.parse(readFileSync(join('dev-mesh', 'orchestrator', '.agent', 'schedule.json'), 'utf8'));
  const job = s.jobs.find((j) => j.id === 'board-drive');
  assert.ok(job, 'board-drive job present');
  assert.equal(job.kind, 'delegate');
  assert.equal(job.enabled, true);
  assert.equal(job.cadence.kind, 'every');
  assert.ok(/list_my_tasks/.test(job.prompt) && /fanOutToPeers|delegate_to_peer/.test(job.prompt) && /update_my_task/.test(job.prompt),
    'prompt drives the team workflow');
});

test('orchestrator AGENT.md describes the team-lead role', () => {
  const md = readFileSync(join('dev-mesh', 'orchestrator', 'AGENT.md'), 'utf8');
  assert.ok(/team lead|team-lead/i.test(md));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/orchestrator-board-wiring.test.js`
Expected: FAIL — orchestrator peers empty / no board-drive job.

- [ ] **Step 3: Set orchestrator peers in `dev-mesh/mesh.json`**

Replace the orchestrator entry's `"peers": []` with:
```json
      "peers": ["analyst", "tester", "triager", "coder", "reviewer", "curator", "security", "maintainer"]
```

- [ ] **Step 4: Add the board-drive job to `dev-mesh/orchestrator/.agent/schedule.json`**

Add this object to the `jobs` array (after the existing `daily-report-refresh`):
```json
    {
      "id": "board-drive",
      "name": "board-drive — pick up own tickets + coordinate the team",
      "description": "Pick up board tickets assigned to the orchestrator and coordinate the specialist team to resolve them",
      "kind": "delegate",
      "cadence": { "kind": "every", "minutes": 10 },
      "enabled": true,
      "prompt": "You are the team lead. Call list_my_tasks. For EACH ticket not yet 'done': call update_my_task to mark it 'acknowledged', then 'in-progress'. Decide which specialists the task needs — it usually needs MORE THAN ONE (e.g. a code task needs analyst for approach, coder for the change plan, tester for test impact, reviewer for risks). Work as a CONDUCTOR: do dependent stages in order (e.g. approach before plan), and use fanOutToPeers (mode 'ask') to run independent reviews in parallel; use delegate_to_peer (mode 'ask') for a single specialist. Synthesize all specialist outputs into one concise result, then call update_my_task to mark the ticket 'done' with that synthesis. Do not advance any ticket that is not your own. If list_my_tasks is empty, do nothing."
    }
```

- [ ] **Step 5: Add the team-lead note to `dev-mesh/orchestrator/AGENT.md`**

Append:
```markdown

## Team lead (board)

When board tickets are assigned to you, you are the **team lead**: acknowledge the ticket, pull
in the right specialists (usually several — analyst/coder/tester/reviewer/…), run a conductor
workflow (dependent stages in order, independent reviews fanned out in parallel via
`fanOutToPeers`, all ask-mode), synthesize their outputs, and mark your own ticket done with the
result. You never advance another agent's ticket.
```

- [ ] **Step 6: Wire with doctor + update the roster test**

Run: `node ./bin/agent-mesh.js doctor dev-mesh --apply` (regenerates the orchestrator's `registry.json` peers + `agentmesh_peerbridge` `.mcp.json`).
Then in `test/dev-mesh-agents.test.js`, update the assertion that pins the orchestrator's peers. Replace:
```javascript
  assert.deepEqual(byName('orchestrator').peers, []);             // standalone: owns the gh-activity-poll builtin, no onward delegation
```
with:
```javascript
  assert.deepEqual(byName('orchestrator').peers.sort(), ['analyst', 'coder', 'curator', 'maintainer', 'reviewer', 'security', 'tester', 'triager']); // team lead: coordinates the specialist team for board tickets
```

- [ ] **Step 7: Run tests + commit**

Run: `node --test test/orchestrator-board-wiring.test.js test/dev-mesh-agents.test.js`
Expected: PASS.

```bash
git add dev-mesh/ test/orchestrator-board-wiring.test.js test/dev-mesh-agents.test.js
git commit -m "feat(board-pipeline): orchestrator as board team lead — team peers + board-drive job + persona"
```

---

### Task 2: Concierge routes "work" tasks to the orchestrator

**Files:**
- Modify: `dev-mesh/concierge/AGENT.md`
- Test: `test/orchestrator-board-wiring.test.js` (extend)

**Interfaces:**
- Consumes: the concierge `assign_task` dispatcher (peer allowlist already includes `orchestrator`).
- Produces: persona guidance so a "work/build/investigate" request proposes `assign_task` with `peer: "orchestrator"`.

- [ ] **Step 1: Write the failing test**

```javascript
// add to test/orchestrator-board-wiring.test.js
test('concierge persona routes substantive work to the orchestrator', () => {
  const md = readFileSync(join('dev-mesh', 'concierge', 'AGENT.md'), 'utf8');
  assert.ok(/orchestrator/.test(md), 'concierge persona names the orchestrator as the work target');
  // orchestrator must be in the concierge peer set for assign_task to be allowed
  const m = JSON.parse(readFileSync(join('dev-mesh', 'mesh.json'), 'utf8'));
  assert.ok(m.agents.find((a) => a.name === 'concierge').peers.includes('orchestrator'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/orchestrator-board-wiring.test.js`
Expected: FAIL — concierge AGENT.md doesn't mention orchestrator yet.

- [ ] **Step 3: Update `dev-mesh/concierge/AGENT.md`**

In the `assign_task` guidance, add:
```markdown

When the owner wants the mesh to **work on / build / investigate** something substantive,
propose `assign_task` with `peer: "orchestrator"` — the orchestrator is the team lead and will
pull in the specialist team. Use a specific single peer only for a narrow, single-agent ask.
```

- [ ] **Step 4: Run test + commit**

Run: `node --test test/orchestrator-board-wiring.test.js`
Expected: PASS.

```bash
git add dev-mesh/concierge/AGENT.md test/orchestrator-board-wiring.test.js
git commit -m "feat(board-pipeline): concierge routes substantive work to the orchestrator team lead"
```

---

### Task 3: Desktop auto-refresh — Task Board re-renders on the poll

**Files:**
- Modify: `src/dashboard/public/board2.js`

**Interfaces:**
- Consumes: `renderTasksView` (already imported in board2.js from the Task Board feature) + the existing `refresh()` loop (SSE + 30s).

- [ ] **Step 1: Add the re-render to `refresh()`**

In `src/dashboard/public/board2.js`, at the end of `refresh()` (after `renderNetwork();`), add:
```javascript
  // Keep the Task Board live: re-render it on each refresh while it's the active view.
  const tasksEl = document.querySelector('#view-tasks');
  if (tasksEl && tasksEl.classList.contains('on')) renderTasksView(tasksEl);
```

- [ ] **Step 2: Sanity-check + commit (browser-only; no node test)**

Run: `node -e "import('./src/dashboard/public/tasks-model.js').then(()=>console.log('model ok'))"` (the view JS is browser-only). Verify locally if desired: open `/`, click 🎫 tasks, advance a board ticket on disk, confirm it updates within ~30s without manual reload.

```bash
git add src/dashboard/public/board2.js
git commit -m "feat(board-pipeline): desktop Task Board auto-refreshes on the dashboard poll"
```

---

### Task 4: Phone auto-refresh — poll the active data tab

**Files:**
- Modify: `src/dashboard/public/mobile/app.js`
- Test: `test/mobile-pwa.test.js` (extend)

**Interfaces:**
- Produces: `pickPoll(view, { hidden })` — pure: returns the data-tab key to reload (`'status'|'alerts'|'tasks'`) for an auto-poll tick, or `null` for chat / hidden document.

- [ ] **Step 1: Write the failing test**

```javascript
// add to test/mobile-pwa.test.js (import pickPoll from app.js)
import { pickPoll } from '../src/dashboard/public/mobile/app.js';

test('pickPoll returns the active data tab to refresh, never chat, never when hidden', () => {
  assert.equal(pickPoll('status', { hidden: false }), 'status');
  assert.equal(pickPoll('alerts', { hidden: false }), 'alerts');
  assert.equal(pickPoll('tasks', { hidden: false }), 'tasks');
  assert.equal(pickPoll('chat', { hidden: false }), null);    // chat is never auto-polled
  assert.equal(pickPoll('tasks', { hidden: true }), null);     // paused when the tab is backgrounded
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/mobile-pwa.test.js`
Expected: FAIL — `pickPoll` not exported.

- [ ] **Step 3: Implement in `src/dashboard/public/mobile/app.js`**

Add the pure helper (near the other exported helpers, e.g. after `summarizeTaskColumns`):
```javascript
const POLLABLE = new Set(['status', 'alerts', 'tasks']);
// Which data tab to auto-refresh on a poll tick: the active data tab, or null
// (chat is never auto-polled; nothing polls while the document is hidden).
export function pickPoll(view, { hidden = false } = {}) {
  if (hidden) return null;
  return POLLABLE.has(view) ? view : null;
}
```
In `mount()`, after the loaders are defined and tabs wired, add a 15s visibility-aware poll of the active tab:
```javascript
  const loaders = { status: loadStatus, alerts: loadAlerts, tasks: loadTasks };
  let activeView = 'chat';
  document.querySelectorAll('.tab').forEach((tab) => {
    const prev = tab.onclick;
    tab.onclick = (e) => { activeView = tab.dataset.view; return prev && prev.call(tab, e); };
  });
  setInterval(() => {
    const v = pickPoll(activeView, { hidden: document.visibilityState === 'hidden' });
    if (v && loaders[v]) loaders[v]();
  }, 15000);
```
(`activeView` starts `'chat'`, so nothing polls until the owner opens a data tab.)

- [ ] **Step 4: Run test + commit**

Run: `node --test test/mobile-pwa.test.js`
Expected: PASS.

```bash
git add src/dashboard/public/mobile/app.js test/mobile-pwa.test.js
git commit -m "feat(board-pipeline): phone PWA auto-refreshes the active data tab (incl. Tasks)"
```

---

### Task 5: Full-suite gate, docs, PR

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Full suite**

Run: `node run-all-tests.mjs`
Expected: all green. Fix any regression (esp. `test/dev-mesh-agents.test.js`).

- [ ] **Step 2: CLAUDE.md note**

Add one line near the board/orchestrator notes: the **orchestrator-driven board pipeline** (spec 2026-06-22) — orchestrator is the board **team lead** (`board-drive` delegate job; conductor workflow + `fanOutToPeers`, ask-only) that picks up its own board tickets, coordinates the specialist team, and resolves them; concierge routes "work" tasks to it; Task Board auto-refreshes on phone + desktop.

- [ ] **Step 3: Commit + PR**

```bash
git add CLAUDE.md
git commit -m "docs(board-pipeline): note the orchestrator board team-lead pipeline"
```
Open a PR; CI green; squash-merge. deploy-sync ships it + `doctor` wires the orchestrator on the managed sync.

- [ ] **Step 4: Live e2e verification (the goal's real proof)**

From the phone: create an `assign_task` ticket to the orchestrator (via the concierge). Within a `board-drive` poll cycle (~10m, or trigger the job once), confirm: the ticket moves `assigned → acknowledged → in-progress`; the desktop graph shows orchestrator→specialist edges (the team); the ticket reaches `done` with a synthesized result; and both the desktop Task Board and the phone Tasks tab show the progression auto-refreshing.

---

## Self-Review

**Spec coverage:** §team-lead ownership + board-drive → Task 1; §concierge routes work → Task 2; §desktop auto-refresh → Task 3; §phone auto-refresh → Task 4; §conductor-workflow + fan-out → encoded in the Task 1 board-drive prompt + AGENT.md; §safety/invariants → ask-only manifest + board invariant (Task 1, unchanged verbs) + daemon-thin-trigger (existing scheduler); §e2e → Task 5 Step 4. No new read verb (dropped — orchestrator uses its own `list_my_tasks`). All spec sections covered.

**Placeholder scan:** none — every code/config step has complete content; commands have expected output.

**Type consistency:** `pickPoll(view,{hidden})→'status'|'alerts'|'tasks'|null` (T4) matches the loaders map keys; orchestrator peer set is identical in Task 1 Step 3, Step 6, and Task 2's test; the board-drive job shape matches the scheduler `delegate` contract (`id/name/kind/cadence/enabled/prompt`). Consistent.
