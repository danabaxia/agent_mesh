# Schedules Run-Now + Descriptions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-job **Run** button (re-arms `nextRunAt=now` so the daemon runs it ≤30s) and a per-task **description** in the dashboard's mesh-wide Schedules panel.

**Architecture:** Pure `markJobDue`/`describeJob` in `src/schedule/run-now.js`; `list-all` carries `description`; a `POST /api/schedules/run` route that validates the job (manifest + defs + enabled) and writes the re-arm to `schedule-state.json` (daemon stays the single executor); the panel gets a Run button + description.

**Tech Stack:** Node ≥20, ESM, zero deps, `node --test`.

Spec: `docs/superpowers/specs/2026-06-19-schedule-run-now-design.md`.

---

## File structure

| File | Responsibility |
|---|---|
| `src/schedule/run-now.js` (new) | pure `markJobDue(state,id,now)` + `describeJob(job)` |
| `src/schedule/list-all.js` (modify) | add `description: describeJob(job)` to each job |
| `src/dashboard/server.js` (modify) | `POST /api/schedules/run` (re-arm; daemon-owned safe) |
| `src/dashboard/public/graph-view.js` + `graph-view.css` (modify) | Run button + description in `loadSchedules` |
| `dev-mesh/orchestrator/.agent/schedule.json` (modify) | seed `description` on the two jobs |
| `test/schedule-run-now.test.js`, `test/schedules-run-route.test.js` (new) + `test/schedule-list-all.test.js` (extend) | coverage |

---

## Task 1: Pure `run-now.js` (markJobDue + describeJob)

**Files:**
- Create: `src/schedule/run-now.js`
- Test: `test/schedule-run-now.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/schedule-run-now.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markJobDue, describeJob } from '../src/schedule/run-now.js';

const NOW = new Date('2026-06-19T12:00:00Z');

test('markJobDue sets nextRunAt=now + running:false, preserves other state, clones (no mutation)', () => {
  const state = { p: { lastStatus: 'ok', nextRunAt: '2030-01-01T00:00:00Z', running: true }, q: { lastStatus: 'fail' } };
  const next = markJobDue(state, 'p', NOW);
  assert.equal(next.p.nextRunAt, '2026-06-19T12:00:00.000Z');
  assert.equal(next.p.running, false);
  assert.equal(next.p.lastStatus, 'ok');                 // preserved
  assert.deepEqual(next.q, { lastStatus: 'fail' });      // other jobs untouched
  assert.notEqual(next, state);                          // new object
  assert.equal(state.p.running, true);                   // original not mutated
});

test('markJobDue creates the entry if absent / state missing or non-object', () => {
  assert.deepEqual(markJobDue({}, 'p', NOW).p, { nextRunAt: '2026-06-19T12:00:00.000Z', running: false });
  assert.deepEqual(markJobDue(null, 'p', NOW).p, { nextRunAt: '2026-06-19T12:00:00.000Z', running: false });
});

test('describeJob: description → prompt first line → empty; trimmed + capped', () => {
  assert.equal(describeJob({ description: '  Poll GH Actions  ' }), 'Poll GH Actions');
  assert.equal(describeJob({ prompt: '\n\nReview the open PRs\nand comment' }), 'Review the open PRs');
  assert.equal(describeJob({ description: '', prompt: 'fallback line' }), 'fallback line');
  assert.equal(describeJob({}), '');
  assert.equal(describeJob(null), '');
  assert.equal(describeJob({ description: 'x'.repeat(500) }).length, 200);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/schedule-run-now.test.js`
Expected: FAIL — `Cannot find module '../src/schedule/run-now.js'`.

- [ ] **Step 3: Write `src/schedule/run-now.js`**

```js
// Pure helpers for the Schedules panel's run-now + per-task description. No I/O.

const MAX_DESC = 200;

/**
 * Return a new schedule-state object with job `id` marked due now (the daemon's
 * next tick will run it, per its enabled && nextRunAt ≤ now rule). Clones — never
 * mutates the input. Creates the entry if absent.
 */
export function markJobDue(state, id, now = new Date()) {
  const base = (state && typeof state === 'object') ? state : {};
  const prev = (base[id] && typeof base[id] === 'object') ? base[id] : {};
  return { ...base, [id]: { ...prev, nextRunAt: now.toISOString(), running: false } };
}

function firstLine(s) {
  for (const line of String(s).split('\n')) { const t = line.trim(); if (t) return t; }
  return '';
}

/** A human description for a job: explicit `description`, else a delegate job's
 *  `prompt` first line, else ''. Trimmed + length-capped. */
export function describeJob(job) {
  if (!job || typeof job !== 'object') return '';
  const d = typeof job.description === 'string' ? job.description.trim() : '';
  const text = d || (job.prompt ? firstLine(job.prompt) : '');
  return text.slice(0, MAX_DESC);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/schedule-run-now.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/schedule/run-now.js test/schedule-run-now.test.js
git commit -m "feat(schedule): pure markJobDue + describeJob (run-now helpers)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `list-all` carries `description`

**Files:**
- Modify: `src/schedule/list-all.js`
- Test: `test/schedule-list-all.test.js` (extend)

- [ ] **Step 1: Read the current `list-all.js` + its test**

Read `src/schedule/list-all.js` (the `jobs.push({...})` block) and `test/schedule-list-all.test.js` to learn its harness (how it plants an agent + schedule.json and asserts the job list).

- [ ] **Step 2: Add a failing assertion to `test/schedule-list-all.test.js`**

Find the test that plants a job with known fields and asserts the returned job. Add a `description` to a planted job def and assert it round-trips, plus a prompt-fallback case. Concretely, in the fixture where a job def is written, include `description: 'My job desc'` on one job and `prompt: 'Do the thing\nmore'` (no description) on another (or extend an existing one), then assert:
```js
const byId = Object.fromEntries(jobs.map((j) => [j.id, j]));
assert.equal(byId['<job-with-description-id>'].description, 'My job desc');
assert.equal(byId['<job-with-prompt-id>'].description, 'Do the thing');   // prompt first line fallback
```
(Use the REAL job ids/shape the existing test already plants — add the `description`/`prompt` fields to those defs and the two assertions. If the existing test plants only one job, add a second def or extend the single one to also carry `description` and assert it.)

- [ ] **Step 3: Run to verify it fails**

Run: `node --test test/schedule-list-all.test.js`
Expected: FAIL — `description` is `undefined` on the returned jobs.

- [ ] **Step 4: Add `description` in `src/schedule/list-all.js`**

Add the import:
```js
import { describeJob } from './run-now.js';
```
In the `jobs.push({ ... })` object (next to `name`/`cadence`), add:
```js
        description: describeJob(job),
```

- [ ] **Step 5: Run to verify it passes + no regression**

Run: `node --test test/schedule-list-all.test.js` → PASS.
Run: `node --test test/schedules-route.test.js` → PASS (the mesh-wide route reads list-all; additive field).

- [ ] **Step 6: Commit**

```bash
git add src/schedule/list-all.js test/schedule-list-all.test.js
git commit -m "feat(schedule): surface per-job description in the mesh-wide list

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `POST /api/schedules/run`

**Files:**
- Modify: `src/dashboard/server.js`
- Test: `test/schedules-run-route.test.js`

- [ ] **Step 1: Write the failing test `test/schedules-run-route.test.js`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardServer } from '../src/dashboard/server.js';
import { initMesh } from '../src/builder/init-mesh.js';
import { writeManifest } from '../src/builder/manifest.js';

async function meshWithJob() {
  const meshRoot = await mkdtemp(join(tmpdir(), 'runroute-'));
  await initMesh(meshRoot);
  const a = join(meshRoot, 'orchestrator');
  await mkdir(join(a, '.agent'), { recursive: true });
  await writeFile(join(a, 'agent.json'), JSON.stringify({ name: 'orchestrator' }), 'utf8');
  await writeFile(join(a, '.agent', 'schedule.json'), JSON.stringify({ jobs: [
    { id: 'p', name: 'poll', kind: 'builtin', builtin: 'probe', cadence: { kind: 'every', minutes: 5 }, enabled: true },
    { id: 'off', name: 'disabled job', kind: 'builtin', builtin: 'x', cadence: { kind: 'every', minutes: 5 }, enabled: false },
  ] }), 'utf8');
  await mkdir(join(a, '.agent-mesh'), { recursive: true });
  await writeFile(join(a, '.agent-mesh', 'schedule-state.json'), JSON.stringify({ p: { nextRunAt: '2030-01-01T00:00:00Z', lastStatus: 'ok' } }), 'utf8');
  await writeManifest(meshRoot, { meshVersion: '0.1.0', agents: [{ name: 'orchestrator', root: './orchestrator', card: 'agent.json', served: true, enabledModes: ['ask'], peers: [] }] });
  return { meshRoot, statePath: join(a, '.agent-mesh', 'schedule-state.json') };
}

async function boot(meshRoot) {
  const srv = createDashboardServer({ meshRoot, port: 0 });
  await srv.start();
  const port = new URL(srv.url).port;
  const r = await fetch(`${srv.url}/?t=${srv.token}`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'none' }, redirect: 'manual' });
  const cookie = `am_dash=${r.headers.get('set-cookie').match(/am_dash=([^;]+)/)[1]}`;
  return { srv, port, cookie };
}

test('POST /api/schedules/run re-arms an enabled job to now → 202', async () => {
  const { meshRoot, statePath } = await meshWithJob();
  const { srv, port, cookie } = await boot(meshRoot);
  try {
    const r = await fetch(`${srv.url}/api/schedules/run`, { method: 'POST', headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: 'orchestrator', id: 'p' }) });
    assert.equal(r.status, 202);
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.ok(Date.parse(state.p.nextRunAt) <= Date.now() + 1000);     // re-armed to ~now
    assert.equal(state.p.running, false);
    assert.equal(state.p.lastStatus, 'ok');                            // preserved
  } finally { await srv.close(); }
});

test('disabled job → 409; unknown agent/job → 404', async () => {
  const { meshRoot } = await meshWithJob();
  const { srv, port, cookie } = await boot(meshRoot);
  const post = (b) => fetch(`${srv.url}/api/schedules/run`, { method: 'POST', headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  try {
    assert.equal((await post({ agent: 'orchestrator', id: 'off' })).status, 409);
    assert.equal((await post({ agent: 'nope', id: 'p' })).status, 404);
    assert.equal((await post({ agent: 'orchestrator', id: 'ghost' })).status, 404);
  } finally { await srv.close(); }
});

test('unauthenticated → 403', async () => {
  const { meshRoot } = await meshWithJob();
  const srv = createDashboardServer({ meshRoot, port: 0 });
  await srv.start();
  const port = new URL(srv.url).port;
  try {
    const r = await fetch(`${srv.url}/api/schedules/run`, { method: 'POST', headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: 'orchestrator', id: 'p' }) });
    assert.equal(r.status, 403);
  } finally { await srv.close(); }
});
```
VERIFY the boot/auth harness against `test/schedules-route.test.js` / `test/activity-gh-merge.test.js`; copy verbatim if it differs. If `initMesh` already seeds an `orchestrator` or the manifest shape differs, adapt the fixture to the real `writeManifest`/`initMesh` contract while preserving the assertions (enabled job → 202 + re-armed; disabled → 409; unknown → 404; no-auth → 403).

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/schedules-run-route.test.js`
Expected: FAIL — `/api/schedules/run` 404s.

- [ ] **Step 3: Add the route in `src/dashboard/server.js`**

First confirm these are in scope at the route site (the existing `POST /api/agent/:name/schedule/:id/run` route uses them): `readManifest` (imported), `resolve`, `join`, `isPathInsideRoot`, `readScheduleFile`, `isSafeArtifactId`, `readBodyCapped`, `sendJson`, `send404`, `send403`. Add to the `node:fs/promises` import (if not already present): `readFile`, `writeFile`, `mkdir`; and `dirname` from `node:path`. Add the import:
```js
import { markJobDue } from '../schedule/run-now.js';
```
Add the route beside the other schedule routes (in the authenticated `/api/*` scope, so it inherits the same-origin + cookie gate that returns 403 when unauthenticated):
```js
    if (pathname === '/api/schedules/run' && req.method === 'POST') {
      let body;
      try { body = JSON.parse((await readBodyCapped(req, 4096)) || '{}'); }
      catch (err) { sendJson(res, err.tooLarge ? 413 : 400, { ok: false, error: { code: 'bad_input' } }); return; }
      const name = String(body.agent || '');
      const id = String(body.id || '');
      if (!isSafeArtifactId(id)) { sendJson(res, 400, { ok: false, error: { code: 'bad_id' } }); return; }
      let manifest; try { manifest = await readManifest(meshRoot); } catch { manifest = null; }
      const entry = manifest?.agents?.find((a) => a.name === name);
      if (!entry) { send404(res); return; }
      const agentRoot = resolve(join(meshRoot, entry.root));
      if (!(await isPathInsideRoot(meshRoot, agentRoot).catch(() => false))) { send403(res, 'Agent root escapes mesh boundary'); return; }
      const defs = await readScheduleFile(agentRoot);
      const job = defs.jobs.find((j) => j && j.id === id);
      if (!job) { send404(res); return; }
      if (!job.enabled) { sendJson(res, 409, { ok: false, error: { code: 'disabled', message: 'enable the job to run it' } }); return; }
      const statePath = join(agentRoot, '.agent-mesh', 'schedule-state.json');
      let state = {}; try { state = JSON.parse(await readFile(statePath, 'utf8')); } catch { state = {}; }
      const next = markJobDue(state, id, new Date());
      await mkdir(dirname(statePath), { recursive: true });
      await writeFile(statePath, JSON.stringify(next, null, 2) + '\n', 'utf8');
      if (scheduler) Promise.resolve(scheduler.runNow(name, id)).catch(() => { /* recorded in state */ });
      sendJson(res, 202, { ok: true, queued: true, runsWithinMs: 30000 });
      return;
    }
```
ADAPT to the real in-scope helper names (`readScheduleFile` may have a slightly different name — match the one the existing run route uses to read the defs; same for `isPathInsideRoot`/`send404`/`send403`). The route must sit AFTER the auth gate (so unauthenticated → 403) and write ONLY the agent's `schedule-state.json`.

- [ ] **Step 4: Run to verify it passes + no regression**

Run: `node --test test/schedules-run-route.test.js` → PASS (3 tests).
Run: `node --test test/schedules-route.test.js test/schedule-routes.test.js` → PASS (sibling schedule routes unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/server.js test/schedules-run-route.test.js
git commit -m "feat(dashboard): POST /api/schedules/run — re-arm a job for the daemon (≤30s)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Schedules panel — Run button + description

**Files:**
- Modify: `src/dashboard/public/graph-view.js`, `src/dashboard/public/graph-view.css`

UI task — verified visually in Task 6. Additive; match the existing panel idiom.

- [ ] **Step 1: Read `loadSchedules`**

Read the `loadSchedules` function in `src/dashboard/public/graph-view.js` (it renders `#gv-sched` as a table: `agent · job | cadence | last | next run | running`). Note the `esc()`, `agentColor()`, `setText()` helpers and the `pill()` local.

- [ ] **Step 2: Replace the row template + wire the Run button**

In `loadSchedules`, change the rows `.map(...)` to add the description under the name and a Run button in the last cell, then attach click handlers after setting `innerHTML`:
```js
  const pill = (s) => s === 'ok' ? '<span class="state done">ok</span>' : s === 'fail' ? '<span class="state block">fail</span>' : '<span class="state open">—</span>';
  const rows = d.jobs.map((j) => {
    const desc = j.description ? `<div class="sched-desc" title="${esc(j.description)}">${esc(j.description)}</div>` : '';
    const canRun = j.enabled && !j.running;
    const runBtn = `<button class="sched-run" data-run-agent="${esc(j.agent)}" data-run-id="${esc(j.id)}"${canRun ? '' : ' disabled'} title="${j.enabled ? 'run now (≤30s)' : 'enable the job to run it'}">▶ run</button>`;
    return `<tr><td class="title"><span class="tt"><b class="an" style="color:${agentColor(j.agent)}">${esc(j.agent)}</b> · ${esc(j.name)}</span>${desc}</td><td><span class="kind issue">${esc(j.cadenceLabel || '')}</span></td><td>${j.enabled ? pill(j.lastStatus) : '<span class="state open">off</span>'}</td><td class="age">${esc(j.nextRunAt ? new Date(j.nextRunAt).toLocaleString() : '—')}</td><td class="age">${j.running ? '▶ running' : runBtn}</td></tr>`;
  }).join('');
  el.innerHTML = `<table><thead><tr><th>agent · job</th><th>cadence</th><th>last</th><th>next run</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
  el.querySelectorAll('.sched-run').forEach((btn) => btn.addEventListener('click', async () => {
    btn.disabled = true; btn.textContent = 'queued…';
    try {
      await fetch('/api/schedules/run', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: btn.dataset.runAgent, id: btn.dataset.runId }) });
    } catch { /* transient — next poll reflects state */ }
    setTimeout(loadSchedules, 1500);   // refresh so the row shows running → ok/fail
  }));
```
(Use `addEventListener`, NOT inline `onclick` — the dashboard CSP blocks inline handlers. Keep `esc()` on every interpolated string.)

- [ ] **Step 3: Add CSS to `graph-view.css`**

Under `#view-graph` (near the other panel styles), add:
```css
#view-graph .sched-desc { color: var(--ink2); font-size: 11px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 280px; }
#view-graph .sched-run { font: 11px var(--mono); padding: 1px 7px; border: 1px solid var(--line); border-radius: 5px; background: #fff; color: var(--teal); cursor: pointer; }
#view-graph .sched-run:hover:not(:disabled) { background: var(--amber-bg); }
#view-graph .sched-run:disabled { color: var(--idle); cursor: default; opacity: .55; }
```
(Use the palette vars that exist in graph-view.css — `--ink2`, `--mono`, `--line`, `--teal`, `--amber-bg`, `--idle`; if a var is missing, substitute the closest existing one.)

- [ ] **Step 4: Syntax + wiring check**

Run: `node --check src/dashboard/public/graph-view.js` → clean.
Confirm the run button uses `addEventListener` and `loadSchedules` still refreshes via the panel's existing cadence.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/public/graph-view.js src/dashboard/public/graph-view.css
git commit -m "feat(dashboard): Schedules panel — per-job Run button + description

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Seed descriptions on the orchestrator jobs

**Files:**
- Modify: `dev-mesh/orchestrator/.agent/schedule.json`

- [ ] **Step 1: Add `description` to both jobs**

Read `dev-mesh/orchestrator/.agent/schedule.json`. Add a `description` field to each job:
- `gh-activity-poll` → `"Poll GitHub Actions runs into live mesh activity"`
- `daily-report-refresh` → `"Refresh the daily PR / issue / token report cache"`
Keep the rest of each job object unchanged; valid JSON.

- [ ] **Step 2: Validate**

Run: `node -e "JSON.parse(require('node:fs').readFileSync('dev-mesh/orchestrator/.agent/schedule.json','utf8')); console.log('valid json')"`
Run: `node ./bin/agent-mesh.js validate dev-mesh 2>&1 | grep -E 'Conformance|FAIL' || true` → Conformance OK (description is an additive def field; if validate flags an unknown field, that's a real schema constraint — report it; otherwise OK).

- [ ] **Step 3: Commit**

```bash
git add dev-mesh/orchestrator/.agent/schedule.json
git commit -m "chore(dev-mesh): describe the orchestrator's scheduled jobs

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Full-suite verification + visual check

- [ ] **Step 1: Run the whole suite**

Run: `npm test`
Expected: PASS — all existing + new (`schedule-run-now` 3, `schedules-run-route` 3, `schedule-list-all` extended); 0 failures.

- [ ] **Step 2: Live route smoke (real modules, no daemon)**

Plant a temp mesh + enabled job, POST the run route via a booted dashboard, confirm the state file is re-armed:
```bash
node --test test/schedules-run-route.test.js   # already exercises the full route path against a real server
```
(The route test IS the end-to-end check; no extra script needed.)

- [ ] **Step 3: Visual check (Schedules panel)**

Use the `superpowers:verify` skill (real browser) against the dashboard pointed at `dev-mesh` (the orchestrator jobs now carry descriptions): expand the Schedules panel and confirm (a) each row shows its **description** under the name, (b) the **▶ run** button is present + enabled for enabled jobs and greyed for disabled, and (c) clicking it shows "queued…" and the row updates. Capture a screenshot.

- [ ] **Step 4: Commit (empty if clean)**

```bash
git commit --allow-empty -m "test(schedule): run-now + descriptions verified — npm test green + visual

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-review notes (author)

- **Spec: Run button re-arms nextRunAt; daemon runs ≤30s** → Task 1 (`markJobDue`) + Task 3 (route) + Task 4 (button). ✓
- **Spec: daemon single executor; dashboard only marks-due** → Task 3 writes state only; no execution (scheduler.runNow only if dashboard owns it). ✓
- **Spec: enabled-only (disabled → 409 / greyed button)** → Task 3 (409) + Task 4 (`canRun`). ✓
- **Spec: path-safe authenticated route** → Task 3 (manifest + isPathInsideRoot + isSafeArtifactId + auth scope). ✓
- **Spec: description field + prompt fallback, surfaced per row** → Task 1 (`describeJob`) + Task 2 (list-all) + Task 4 (render) + Task 5 (seed). ✓
- **Spec: tests** → Tasks 1/2/3 hermetic; Task 6 visual. ✓
- **Naming consistency:** `markJobDue`, `describeJob`, `/api/schedules/run`, `description`, `runsWithinMs`, `sched-run`, `sched-desc` — identical across tasks.
- **Deferred (per spec):** force-run-disabled; instant file-watch run; run history.
