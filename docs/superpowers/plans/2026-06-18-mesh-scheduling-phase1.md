# Mesh Scheduling — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the mesh scheduler standard, always-on infrastructure — relocate the engine to `src/schedule/`, run it 24/7 in the dev-society daemon, and surface all agents' schedules read-only in the dashboard.

**Architecture:** The existing, tested scheduler engine (per-agent `.agent/schedule.json` defs, `.agent-mesh/schedule-state.json` state, 30s tick, ask-mode `delegateTask`) is **moved** out of `src/dashboard/` into a neutral `src/schedule/` module, **started by the daemon** (the always-on owner), and **read** by the dashboard via a new mesh-wide `GET /api/schedules` + a Schedules panel. Schedules are agent-level; the dashboard never executes jobs (single owner).

**Tech Stack:** Node ≥20, ESM, zero deps, `node --test`. Reuses `createScheduler`, `describeCadence`, `readManifest`, `delegateTask`.

Spec: `docs/superpowers/specs/2026-06-18-mesh-scheduling-ops-design.md` (Phase 1). Phases 2–3 are separate specs.

---

## File structure

| File | Responsibility |
|---|---|
| `src/schedule/scheduler.js` (moved from `src/dashboard/`) | The scheduler engine — unchanged behavior, now mesh-level |
| `src/schedule/schedule-cadence.js` (moved) | Pure cadence utilities |
| `src/schedule/list-all.js` (new) | Pure-ish `listAllSchedules` — aggregate every agent's defs+state into the mesh list |
| `src/dashboard/server.js` (modify) | Repoint imports; add `GET /api/schedules` |
| `scripts/dev-society-daemon.mjs` (modify) | Start/stop the scheduler 24/7 |
| `src/dashboard/public/graph-view.js` / `.css` (modify) | Read-only Schedules section in the Graph view |
| `test/scheduler.test.js`, `test/schedule-cadence.test.js` (modify) | Repoint imports |
| `test/schedule-list-all.test.js`, `test/schedules-route.test.js`, `test/daemon-scheduler.test.js` (new) | Aggregator, route, daemon-wiring tests |

---

## Task 1: Relocate the scheduler engine to `src/schedule/` (standard infra)

Behavior-preserving move; the existing tests are the safety net.

**Files:**
- Move: `src/dashboard/scheduler.js` → `src/schedule/scheduler.js`
- Move: `src/dashboard/schedule-cadence.js` → `src/schedule/schedule-cadence.js`
- Modify: `src/dashboard/server.js:52-53`, `test/scheduler.test.js:18-19`, `test/schedule-cadence.test.js:8`

- [ ] **Step 1: Move both files with git (preserves history)**

```bash
cd /Users/jingbohan/Documents/dev/agent_mesh
mkdir -p src/schedule
git mv src/dashboard/scheduler.js src/schedule/scheduler.js
git mv src/dashboard/schedule-cadence.js src/schedule/schedule-cadence.js
```

(The engine's relative imports — `../builder/manifest.js`, `./schedule-cadence.js`, `../delegate.js` — remain valid because `src/schedule/` and `src/dashboard/` are both one level under `src/`.)

- [ ] **Step 2: Repoint the server imports**

In `src/dashboard/server.js`, change lines 52-53 from:
```js
import { createScheduler } from './scheduler.js';
import { validateCadence, describeCadence } from './schedule-cadence.js';
```
to:
```js
import { createScheduler } from '../schedule/scheduler.js';
import { validateCadence, describeCadence } from '../schedule/schedule-cadence.js';
```

- [ ] **Step 3: Repoint the test imports**

In `test/scheduler.test.js` change lines 18-19:
```js
import { createScheduler } from '../src/schedule/scheduler.js';
import { computeNextRun } from '../src/schedule/schedule-cadence.js';
```
In `test/schedule-cadence.test.js` change the import (line ~5-8) to:
```js
} from '../src/schedule/schedule-cadence.js';
```

- [ ] **Step 4: Run the moved tests + the dashboard tests (safety net)**

Run: `node --test test/scheduler.test.js test/schedule-cadence.test.js test/schedule-routes.test.js test/dashboard-server.test.js`
Expected: PASS (no behavior changed; only paths moved).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(schedule): relocate scheduler engine to src/schedule (standard mesh infra)"
```

---

## Task 2: `listAllSchedules` — mesh-wide aggregator

**Files:**
- Create: `src/schedule/list-all.js`
- Test: `test/schedule-list-all.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/schedule-list-all.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listAllSchedules } from '../src/schedule/list-all.js';

// Injected fs/manifest stubs keep it hermetic.
function fixture() {
  const manifest = { agents: [
    { name: 'coder', root: './coder' },
    { name: 'reviewer', root: './reviewer' },
  ] };
  const files = {
    // coder: one enabled daily job with state
    '/m/coder/.agent/schedule.json': { jobs: [{ id: 'j1', name: 'Nightly', cadence: { kind: 'daily', at: '07:00' }, enabled: true }] },
    '/m/coder/.agent-mesh/schedule-state.json': { j1: { lastRunAt: '2026-06-18T07:00:00Z', lastStatus: 'ok', lastSummary: 'done', nextRunAt: '2026-06-19T07:00:00Z', running: false } },
    // reviewer: one disabled job, no state
    '/m/reviewer/.agent/schedule.json': { jobs: [{ id: 'j2', name: 'Hourly', cadence: { kind: 'every', minutes: 60 }, enabled: false }] },
  };
  const readManifestFn = async () => manifest;
  const readJsonFn = async (path, fallback) => (path in files ? files[path] : fallback);
  return { readManifestFn, readJsonFn };
}

test('listAllSchedules aggregates every agent job with merged state + cadence label', async () => {
  const { readManifestFn, readJsonFn } = fixture();
  const { jobs } = await listAllSchedules({ meshRoot: '/m', readManifestFn, readJsonFn });
  assert.equal(jobs.length, 2);
  const j1 = jobs.find((j) => j.id === 'j1');
  assert.equal(j1.agent, 'coder');
  assert.equal(j1.enabled, true);
  assert.equal(j1.lastStatus, 'ok');
  assert.equal(j1.nextRunAt, '2026-06-19T07:00:00Z');
  assert.ok(/daily|07:00/i.test(j1.cadenceLabel), 'has a human cadence label');
  const j2 = jobs.find((j) => j.id === 'j2');
  assert.equal(j2.agent, 'reviewer');
  assert.equal(j2.enabled, false);
  assert.equal(j2.lastStatus, null);   // no state file → nulls
  assert.equal(j2.running, false);
});

test('listAllSchedules on unreadable manifest → empty', async () => {
  const { jobs } = await listAllSchedules({ meshRoot: '/m', readManifestFn: async () => { throw new Error('nope'); }, readJsonFn: async (_p, f) => f });
  assert.deepEqual(jobs, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/schedule-list-all.test.js`
Expected: FAIL — `Cannot find module '../src/schedule/list-all.js'`.

- [ ] **Step 3: Write the implementation**

```js
// src/schedule/list-all.js
// Pure-ish mesh-wide aggregation of agent-level schedules. Reads each served
// agent's .agent/schedule.json (defs) + .agent-mesh/schedule-state.json (state)
// and merges them into one read-only list. Effectful deps are injected.
import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { readManifest } from '../builder/manifest.js';
import { describeCadence } from './schedule-cadence.js';

async function readJsonDefault(path, fallback) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch { return fallback; }
}

export async function listAllSchedules({ meshRoot, readManifestFn = readManifest, readJsonFn = readJsonDefault }) {
  const root = resolve(meshRoot);
  let manifest;
  try { manifest = await readManifestFn(root); } catch { return { jobs: [] }; }
  const agents = (Array.isArray(manifest?.agents) ? manifest.agents : [])
    .filter((a) => a && typeof a.name === 'string' && typeof a.root === 'string');
  const jobs = [];
  for (const a of agents) {
    const agentRoot = resolve(join(root, a.root));
    const defs = await readJsonFn(join(agentRoot, '.agent', 'schedule.json'), { jobs: [] });
    const state = await readJsonFn(join(agentRoot, '.agent-mesh', 'schedule-state.json'), {});
    for (const job of (Array.isArray(defs.jobs) ? defs.jobs : [])) {
      if (!job || typeof job.id !== 'string') continue;
      const e = (state && state[job.id]) || {};
      jobs.push({
        agent: a.name,
        id: job.id,
        name: job.name ?? job.id,
        cadence: job.cadence ?? null,
        cadenceLabel: job.cadence ? describeCadence(job.cadence) : '',
        enabled: !!job.enabled,
        lastRunAt: e.lastRunAt ?? null,
        lastStatus: e.lastStatus ?? null,
        lastSummary: e.lastSummary ?? '',
        nextRunAt: e.nextRunAt ?? null,
        running: !!e.running,
      });
    }
  }
  return { jobs };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/schedule-list-all.test.js`
Expected: PASS (2 tests). (If `describeCadence` throws on the test cadences, that surfaces here — but it accepts `{kind:'daily',at}` / `{kind:'every',minutes}`.)

- [ ] **Step 5: Commit**

```bash
git add src/schedule/list-all.js test/schedule-list-all.test.js
git commit -m "feat(schedule): listAllSchedules — mesh-wide read-only aggregation of agent jobs"
```

---

## Task 3: `GET /api/schedules` route

**Files:**
- Modify: `src/dashboard/server.js` (add import + route)
- Test: `test/schedules-route.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/schedules-route.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardServer } from '../src/dashboard/server.js';
import { initMesh } from '../src/builder/init-mesh.js';
import { writeManifest } from '../src/builder/manifest.js';

async function buildMesh() {
  const meshRoot = await mkdtemp(join(tmpdir(), 'schedroutes-'));
  await initMesh(meshRoot);
  const coder = join(meshRoot, 'coder');
  await mkdir(join(coder, '.agent'), { recursive: true });
  await mkdir(join(coder, '.agent-mesh'), { recursive: true });
  await writeFile(join(coder, 'agent.json'), JSON.stringify({ name: 'coder' }), 'utf8');
  await writeFile(join(coder, '.agent', 'schedule.json'), JSON.stringify({ jobs: [{ id: 'j1', name: 'Nightly', cadence: { kind: 'daily', at: '07:00' }, enabled: true }] }), 'utf8');
  await writeFile(join(coder, '.agent-mesh', 'schedule-state.json'), JSON.stringify({ j1: { lastStatus: 'ok', nextRunAt: '2026-06-19T07:00:00Z', running: false } }), 'utf8');
  await writeManifest(meshRoot, { meshVersion: '0.1.0', agents: [{ name: 'coder', root: './coder', card: 'agent.json', served: true, enabledModes: ['ask'], peers: [] }] });
  return { meshRoot };
}
async function authed(meshRoot, opts = {}) {
  const srv = createDashboardServer({ meshRoot, port: 0, ...opts });
  await srv.start(); const port = new URL(srv.url).port;
  const boot = await fetch(`${srv.url}/?t=${srv.token}`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'none' }, redirect: 'manual' });
  const cookie = `am_dash=${boot.headers.get('set-cookie').match(/am_dash=([^;]+)/)[1]}`;
  return { srv, port, cookie };
}
const get = (srv, port, cookie, p) => fetch(`${srv.url}${p}`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie } });

test('GET /api/schedules aggregates agent jobs; owner=daemon when dashboard has no scheduler', async () => {
  const { meshRoot } = await buildMesh();
  const { srv, port, cookie } = await authed(meshRoot);  // no allowShell → dashboard owns no scheduler
  try {
    const r = await get(srv, port, cookie, '/api/schedules');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.schedulerOwner, 'daemon');
    assert.equal(body.jobs.length, 1);
    assert.equal(body.jobs[0].agent, 'coder');
    assert.equal(body.jobs[0].lastStatus, 'ok');
  } finally { await srv.close(); }
});

test('GET /api/schedules without cookie → 403', async () => {
  const { meshRoot } = await buildMesh();
  const srv = createDashboardServer({ meshRoot, port: 0 });
  await srv.start(); const port = new URL(srv.url).port;
  try {
    const r = await fetch(`${srv.url}/api/schedules`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' } });
    assert.equal(r.status, 403);
  } finally { await srv.close(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/schedules-route.test.js`
Expected: FAIL — 404 (route missing) so `body.jobs` is undefined / status ≠ 200.

- [ ] **Step 3: Add the import + route to `server.js`**

Add the import near the other `../schedule/` import (after line 53):
```js
import { listAllSchedules } from '../schedule/list-all.js';
```

Add the route immediately AFTER the `GET /api/tokens` route block (it ends with `return; }`). The `sched` variable (the dashboard's own scheduler, non-null only with `--allow-shell`) is in scope in `handleRequest`? It is NOT — `sched` lives in `createDashboardServer`. So thread a boolean: in the `handleRequest({ … })` options add `dashboardOwnsScheduler`, and pass `dashboardOwnsScheduler: schedulerOwned` at the call site (next to `dailyReportDir`). Then:

```js
  // GET /api/schedules → mesh-wide read-only view of every agent's scheduled
  // jobs (defs + runtime state). The daemon owns execution; this is a window.
  if (pathname === '/api/schedules' && req.method === 'GET') {
    const { jobs } = await listAllSchedules({ meshRoot });
    const schedulerOwner = dashboardOwnsScheduler ? 'dashboard' : (jobs.length ? 'daemon' : 'none');
    sendJson(res, 200, { schedulerOwner, jobs });
    return;
  }
```

In `handleRequest(req, res, { … })`'s destructured options, add `dashboardOwnsScheduler` to the list. At the `handleRequest(req, res, { … })` call site inside `createDashboardServer`, add `dashboardOwnsScheduler: schedulerOwned,` (the existing `schedulerOwned` boolean from `const schedulerOwned = !scheduler && !!sched;`).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/schedules-route.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/server.js test/schedules-route.test.js
git commit -m "feat(dashboard): GET /api/schedules — mesh-wide read-only schedule view"
```

---

## Task 4: Daemon starts the scheduler 24/7

**Files:**
- Modify: `scripts/dev-society-daemon.mjs`
- Test: `test/daemon-scheduler.test.js`

- [ ] **Step 1: Write the failing test (source-shape lint, the repo's script-wiring pattern)**

```js
// test/daemon-scheduler.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('../scripts/dev-society-daemon.mjs', import.meta.url)), 'utf8');

test('daemon wires the standard scheduler from src/schedule, runs it 24/7', () => {
  assert.match(src, /from '\.\.\/src\/schedule\/scheduler\.js'/, 'imports createScheduler from src/schedule');
  assert.match(src, /createScheduler\(/, 'creates a scheduler');
  assert.match(src, /DEV_SOCIETY_MESH_ROOT/, 'mesh root is configurable');
  assert.match(src, /\.start\(\)/, 'starts the scheduler');
  assert.match(src, /\.stop\(\)/, 'stops the scheduler on shutdown');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/daemon-scheduler.test.js`
Expected: FAIL — the daemon does not yet import/start the scheduler.

- [ ] **Step 3: Wire the scheduler into the daemon**

In `scripts/dev-society-daemon.mjs`, add the import near the other `src/` imports (alongside `import * as core from '../src/dev-society/core.js';`):
```js
import { createScheduler } from '../src/schedule/scheduler.js';
```

Add a mesh-root constant near the `cfg` block:
```js
const SCHED_MESH_ROOT = process.env.DEV_SOCIETY_MESH_ROOT || join(repoRoot, 'dev-mesh');
```

Find the poll-forever entrypoint (the `main`/bottom block that runs when not `--selftest`/`--once`). Start the scheduler there — only for the long-running poll mode, not `--selftest` (which must stay side-effect-free) and not `--once`:
```js
// Always-on standard scheduler: runs agents' .agent/schedule.json jobs 24/7
// (the dashboard only visualises via /api/schedules). Skipped in --once/--selftest.
let sched = null;
if (!once && !selftest) {
  sched = createScheduler({ meshRoot: SCHED_MESH_ROOT });
  sched.start();
  log('scheduler started — meshRoot=' + SCHED_MESH_ROOT);
}
```
Wire `sched.stop()` into the daemon's shutdown path. If the daemon has a `process.on('SIGTERM'/'SIGINT', …)` handler, add `sched?.stop()` there; otherwise add:
```js
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { try { sched?.stop(); } catch {} process.exit(0); });
```

(Place these so `once`, `selftest`, `log`, and `repoRoot` are already defined — they are declared near the top of the existing daemon.)

- [ ] **Step 4: Run the wiring test + the daemon selftest (must still be side-effect-free)**

Run: `node --test test/daemon-scheduler.test.js`
Expected: PASS.
Run: `DEV_SOCIETY_REPO=x node scripts/dev-society-daemon.mjs --selftest`
Expected: exits 0, prints `selftest OK` — and does NOT start the scheduler (no "scheduler started" line).

- [ ] **Step 5: Commit**

```bash
git add scripts/dev-society-daemon.mjs test/daemon-scheduler.test.js
git commit -m "feat(dev-society): run the standard scheduler 24/7 in the daemon"
```

---

## Task 5: Dashboard Schedules panel (Graph view, read-only)

Frontend only (no unit-test harness for tab JS — covered by the route test + manual). Adds a foldable "Schedules" section to the Graph view.

**Files:**
- Modify: `src/dashboard/public/graph-view.js` (template + a `loadSchedules()` renderer + fold wiring already generic)
- Modify: `src/dashboard/public/graph-view.css` (table reuse)

- [ ] **Step 1: Add the section to the `TEMPLATE` in `graph-view.js`**

In the `<div class="lower"> … </div>` of `TEMPLATE`, after the issues section (`<div class="sec" id="sec-issues">…</div>`), add:
```html
  <div class="sec" id="sec-sched">
    <div class="shead" data-fold><span class="caret">▾</span><span>⏱ SCHEDULES</span><span class="meta" id="gv-sched-owner">—</span><span class="maxbtn" data-max title="full size">⤢</span></div>
    <div class="secbody"><div class="tscroll" id="gv-sched"></div></div>
  </div>
```

- [ ] **Step 2: Add `loadSchedules()` and call it from `loadAll()`**

In `graph-view.js`, add to the `loadAll()` body (next to `loadDaily()`):
```js
  loadSchedules();
```
Then add the function (next to `loadDaily`):
```js
async function loadSchedules() {
  let d; try { d = await (await fetch('/api/schedules')).json(); } catch { return; }
  setText('gv-sched-owner', `engine: ${d.schedulerOwner || '—'} · ${(d.jobs || []).length} jobs`);
  const el = root.querySelector('#gv-sched');
  if (!d.jobs || !d.jobs.length) { el.innerHTML = '<div class="gv-empty">No scheduled jobs. Add one to an agent’s .agent/schedule.json; the daemon runs them 24/7.</div>'; return; }
  const pill = (s) => s === 'ok' ? '<span class="state done">ok</span>' : s === 'fail' ? '<span class="state block">fail</span>' : '<span class="state open">—</span>';
  const rows = d.jobs.map((j) => `<tr><td class="title"><span class="tt"><b class="an" style="color:${agentColor(j.agent)}">${esc(j.agent)}</b> · ${esc(j.name)}</span></td><td><span class="kind issue">${esc(j.cadenceLabel || '')}</span></td><td>${j.enabled ? pill(j.lastStatus) : '<span class="state open">off</span>'}</td><td class="age">${esc(j.nextRunAt ? new Date(j.nextRunAt).toLocaleString() : '—')}</td><td class="age">${j.running ? '▶ running' : ''}</td></tr>`).join('');
  el.innerHTML = `<table><thead><tr><th>agent · job</th><th>cadence</th><th>last</th><th>next run</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}
```

- [ ] **Step 3: Verify the file parses and the route shape matches**

Run: `node --check src/dashboard/public/graph-view.js`
Expected: no output (syntax OK).
(The `loadSchedules` fetch shape matches Task 3's `{ schedulerOwner, jobs:[{agent,name,cadenceLabel,enabled,lastStatus,nextRunAt,running}] }`.)

- [ ] **Step 4: Commit**

```bash
git add src/dashboard/public/graph-view.js src/dashboard/public/graph-view.css
git commit -m "feat(dashboard): read-only Schedules section in the Graph view"
```

---

## Task 6: Full-suite verification

- [ ] **Step 1: Run the whole suite**

Run: `npm test`
Expected: PASS — all existing + new tests; 0 failures, only the pre-existing `AGENT_MESH_E2E` skips. New tests: `schedule-list-all` (2), `schedules-route` (2), `daemon-scheduler` (1); moved tests still green.

- [ ] **Step 2: Live smoke (optional, manual)**

```bash
node ./bin/agent-mesh.js dashboard dev-mesh --no-open &   # then curl /api/schedules
```
Expected: `/api/schedules` → 200 `{ schedulerOwner:'daemon', jobs:[…] }` (empty `jobs` until an agent has a `.agent/schedule.json`).

- [ ] **Step 3: Commit (empty if clean)**

```bash
git commit --allow-empty -m "test(schedule): Phase 1 verified (npm test green)"
```

---

## Self-review notes (author)

- **Spec §Phase-1 component 1 (relocate)** → Task 1. ✓
- **Component 2 (daemon integration)** → Task 4 (start 24/7, `DEV_SOCIETY_MESH_ROOT`, skip in once/selftest, stop on shutdown). ✓
- **Component 3 (mesh-wide visibility)** → Task 2 (`listAllSchedules`) + Task 3 (`/api/schedules`) + Task 5 (panel). ✓
- **Component 4 (single-owner safety)** → Task 3 `schedulerOwner` reports who runs it; daemon is the only one that calls `start()`; the dashboard's `sched` is still gated behind `--allow-shell` (unchanged). ✓
- **Levels invariant** (agent-level schedules, mesh-level aggregation) → `listAllSchedules` aggregates per-agent defs; no mesh job store. ✓
- **Naming consistency:** `listAllSchedules`, `schedulerOwner`, `dashboardOwnsScheduler`, `createScheduler`, `describeCadence`, `SCHED_MESH_ROOT`/`DEV_SOCIETY_MESH_ROOT` — used identically across tasks.
- **Deferred:** the activity-graph animation benefit is a *consequence* of jobs running against dev-mesh agents (no extra task); the GitHub poller (Phase 2) and heartbeat (Phase 3) are separate specs.
