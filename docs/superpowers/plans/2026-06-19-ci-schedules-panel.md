# CI Schedules Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface GitHub Actions cron-scheduled workflows in the dashboard SCHEDULES panel alongside the mesh daemon jobs, each labeled by executor, read-only.

**Architecture:** A pure module (`src/dev-society/ci-schedules.js`) parses workflow YAML for crons + the top-level `name:`, normalizes GitHub conclusions, and enriches from the already-cached `.dev-society/gh-activity.json` (no new `gh` calls). A read-only `GET /api/ci-schedules` route serves it; `graph-view.js loadSchedules` renders a second "GitHub Actions" group. Spec: `docs/superpowers/specs/2026-06-19-ci-schedules-panel-design.md`.

**Tech Stack:** Node ≥ 20 ESM, `node --test`, zero dependencies; browser JS for the panel.

## Global Constraints

- **Node ≥ 20, ESM, zero dependencies** — no new packages; tests use `node --test`.
- **`ci-schedules.js` is pure** — no I/O, no `Date.now()`; inputs (`files`, `ghActivity`) are parameters. Only the route does disk reads.
- **No new `gh` calls** — status comes only from the existing gh-activity cache.
- **Indentation/section-aware parsing** — `workflow` = first **column-0** `name:` (quotes stripped; basename-sans-`.yml` fallback); `crons` = `cron:` values **only inside the `on:`→`schedule:` block**; **skip full-line `#` comments**; **strip inline trailing comments** after the cron scalar (`- cron: '*/30 * * * *' # poll` → `*/30 * * * *`). Schedule-less workflows excluded.
- **`normalizeCiStatus`**: `success`→`ok`; `failure`/`timed_out`/`startup_failure`→`fail`; everything else (`cancelled`/`skipped`/`neutral`/`action_required`/`null`/missing)→`null`.
- **gh-activity shape**: node `{ id:"gh-<dbid>", route:"ci:<workflowDisplayName>", started_at, finished_at? }`; edge `{ id:"gh-<dbid>:e", status:<conclusion|null> }`. Match by display name (`route.slice(3)`); status from the `:e` edge (absent for orchestrator-mapped workflows → `null`).
- **Cache fallback**: missing/corrupt gh-activity cache → still return the parsed cron workflows (status `—`); only a missing/unreadable **workflows dir** → `{ workflows: [] }`. Never throw.
- **`/api/ci-schedules` is read-only + auth-gated** by the dashboard's existing upstream cookie/Sec-Fetch gate (403 without it, like `/api/schedules`). The existing `/api/schedules` route is untouched.
- **No cron→next-run computation** (show the cron expression; next = `—`).

---

### Task 1: `ci-schedules.js` — pure parse + normalize + enrich

**Files:**
- Create: `src/dev-society/ci-schedules.js`
- Test: `test/ci-schedules.test.js`

**Interfaces:**
- Produces: `parseCronWorkflows(files) → [{ workflow, file, crons }]`; `normalizeCiStatus(conclusion) → 'ok'|'fail'|null`; `latestCiRuns(ghActivity) → Map<name,{lastRunAt,running,status}>`; `listCiSchedules({ files, ghActivity }) → [{ executor, workflow, file, cron, cadenceLabel, lastRunAt, running, status }]`.

- [ ] **Step 1: Write the failing test**

```js
// test/ci-schedules.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCronWorkflows, normalizeCiStatus, latestCiRuns, listCiSchedules } from '../src/dev-society/ci-schedules.js';

const integ = { name: 'integration.yml', text:
`name: Integration (nightly)
on:
  schedule:
    - cron: '0 7 * * *'
  workflow_dispatch:
jobs:
  l1:
    name: L1 e2e
    steps:
      - name: run
        run: echo hi
` };
const backlog = { name: 'dev-mesh-backlog.yml', text:
`name: dev-mesh-backlog
on:
  schedule:
    - cron: '*/30 * * * *' # poll
    - cron: '5 0 * * *'
` };
const commented = { name: 'cm.yml', text:
`name: cm
on:
  schedule:
    # - cron: '0 0 * * *'
    - cron: '15 * * * *'
` };
const noName = { name: 'anon.yml', text: `on:\n  schedule:\n    - cron: '1 * * * *'\n` };
const pushOnly = { name: 'ci.yml', text: `name: ci\non:\n  push:\n    branches: [main]\njobs:\n  t:\n    steps:\n      - name: x\n        run: y\n` };

test('parseCronWorkflows: top-level name only, multi-cron, inline + full-line comments, schedule-less excluded', () => {
  const got = parseCronWorkflows([integ, backlog, commented, noName, pushOnly]);
  const by = Object.fromEntries(got.map((w) => [w.file, w]));
  assert.equal(by['integration.yml'].workflow, 'Integration (nightly)');   // quoted special-char name
  assert.deepEqual(by['integration.yml'].crons, ['0 7 * * *']);             // nested job/step `name:` ignored
  assert.deepEqual(by['dev-mesh-backlog.yml'].crons, ['*/30 * * * *', '5 0 * * *']); // inline comment stripped, multi
  assert.deepEqual(by['cm.yml'].crons, ['15 * * * *']);                     // commented cron excluded
  assert.equal(by['anon.yml'].workflow, 'anon');                            // basename fallback
  assert.equal(by['ci.yml'], undefined);                                    // push-only excluded
});

test('normalizeCiStatus maps GitHub conclusions', () => {
  assert.equal(normalizeCiStatus('success'), 'ok');
  assert.equal(normalizeCiStatus('failure'), 'fail');
  assert.equal(normalizeCiStatus('timed_out'), 'fail');
  assert.equal(normalizeCiStatus('cancelled'), null);
  assert.equal(normalizeCiStatus(null), null);
  assert.equal(normalizeCiStatus(undefined), null);
});

test('latestCiRuns keys by display name, latest wins, status from :e edge, running when unfinished', () => {
  const gh = [
    { id: 'gh-1', route: 'ci:dev-mesh-backlog', started_at: '2026-06-20T01:00:00Z', finished_at: '2026-06-20T01:01:00Z' },
    { id: 'gh-1:e', status: 'success' },
    { id: 'gh-2', route: 'ci:dev-mesh-backlog', started_at: '2026-06-20T02:00:00Z' }, // newer, unfinished, no edge
  ];
  const m = latestCiRuns(gh);
  const e = m.get('dev-mesh-backlog');
  assert.equal(e.lastRunAt, '2026-06-20T02:00:00Z');  // latest by started_at
  assert.equal(e.running, true);
  assert.equal(e.status, null);                        // newest has no edge
});

test('listCiSchedules: enriched / orchestrator-no-edge / absent-from-cache all yield a row', () => {
  const gh = [
    { id: 'gh-9', route: 'ci:dev-mesh-backlog', started_at: '2026-06-20T01:00:00Z', finished_at: '2026-06-20T01:01:00Z' },
    { id: 'gh-9:e', status: 'failure' },
    { id: 'gh-7', route: 'ci:Integration (nightly)', started_at: '2026-06-20T07:00:00Z', finished_at: '2026-06-20T07:30:00Z' }, // no :e
  ];
  const rows = listCiSchedules({ files: [integ, backlog, commented], ghActivity: gh });
  const by = Object.fromEntries(rows.map((r) => [r.file, r]));
  assert.equal(by['dev-mesh-backlog.yml'].status, 'fail');                  // edge → normalized
  assert.equal(by['dev-mesh-backlog.yml'].executor, 'GitHub Actions');
  assert.match(by['dev-mesh-backlog.yml'].cadenceLabel, /\*\/30 \* \* \* \*/);
  assert.equal(by['integration.yml'].lastRunAt, '2026-06-20T07:30:00Z');    // run cached
  assert.equal(by['integration.yml'].status, null);                        // orchestrator-mapped, no edge
  assert.equal(by['cm.yml'].lastRunAt, null);                              // absent from cache → still a row
  assert.equal(by['cm.yml'].status, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/ci-schedules.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `ci-schedules.js`**

```js
// src/dev-society/ci-schedules.js — pure: parse GH Actions cron workflows + enrich
// last-run/status from the gh-activity cache. No I/O, no Date.now().

const unquote = (s) => String(s).trim().replace(/^['"]|['"]$/g, '');

/** Extract a cron scalar value, comment-safe: prefer the quoted scalar, else strip a trailing ` #…`. */
function cronValue(afterColon) {
  const m = afterColon.match(/^\s*(['"])(.*?)\1/);          // quoted: take inside, ignore trailing comment
  if (m) return m[2];
  return afterColon.replace(/\s+#.*$/, '').trim();          // unquoted: strip inline comment
}

/** Indentation/section-aware scan: top-level name + crons inside on.schedule only. */
export function parseCronWorkflows(files = []) {
  const out = [];
  for (const f of files) {
    const lines = String(f?.text ?? '').split('\n');
    let workflow = '';
    let inOn = false, onIndent = -1, inSchedule = false, scheduleIndent = -1;
    const crons = [];
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, '');
      if (!line.trim()) continue;
      const indent = line.length - line.trimStart().length;
      const trimmed = line.trim();
      const isComment = trimmed.startsWith('#');
      // top-level name (column 0)
      if (indent === 0 && /^name:/.test(trimmed) && !workflow) workflow = unquote(trimmed.slice(5));
      // track top-level `on:` (key at column 0)
      if (indent === 0) {
        inOn = /^on:/.test(trimmed);
        onIndent = inOn ? 0 : -1;
        inSchedule = false; scheduleIndent = -1;
        continue;
      }
      if (!inOn) continue;
      // inside on: find schedule: child (deeper than on)
      if (!isComment && /^schedule:/.test(trimmed) && indent > onIndent) {
        inSchedule = true; scheduleIndent = indent; continue;
      }
      // leaving schedule block: a key at <= schedule indent that isn't a list item
      if (inSchedule && indent <= scheduleIndent && !trimmed.startsWith('-')) inSchedule = false;
      if (inSchedule && !isComment) {
        const cm = trimmed.match(/^-?\s*cron:(.*)$/);
        if (cm) crons.push(cronValue(cm[1]));
      }
    }
    if (crons.length) out.push({ workflow: workflow || String(f.name).replace(/\.ya?ml$/, ''), file: f.name, crons });
  }
  return out;
}

export function normalizeCiStatus(conclusion) {
  if (conclusion === 'success') return 'ok';
  if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'startup_failure') return 'fail';
  return null;
}

export function latestCiRuns(ghActivity = []) {
  const arr = Array.isArray(ghActivity) ? ghActivity : [];
  const edgeStatus = new Map();      // "<id>:e" → status
  for (const r of arr) if (r && typeof r.id === 'string' && r.id.endsWith(':e')) edgeStatus.set(r.id, r.status ?? null);
  const byName = new Map();
  for (const r of arr) {
    if (!r || typeof r.route !== 'string' || !r.route.startsWith('ci:') || (r.id || '').endsWith(':e')) continue;
    const name = r.route.slice(3);
    const prev = byName.get(name);
    if (prev && String(prev._started) >= String(r.started_at || '')) continue;
    byName.set(name, {
      _started: r.started_at || '',
      lastRunAt: r.finished_at || r.started_at || null,
      running: !r.finished_at,
      status: normalizeCiStatus(edgeStatus.get(`${r.id}:e`)),
    });
  }
  for (const v of byName.values()) delete v._started;
  return byName;
}

export function listCiSchedules({ files = [], ghActivity = [] } = {}) {
  const runs = latestCiRuns(ghActivity);
  return parseCronWorkflows(files)
    .map((w) => {
      const r = runs.get(w.workflow) || {};
      return {
        executor: 'GitHub Actions',
        workflow: w.workflow, file: w.file, cron: w.crons,
        cadenceLabel: 'cron ' + w.crons.join(', '),
        lastRunAt: r.lastRunAt ?? null, running: !!r.running, status: r.status ?? null,
      };
    })
    .sort((a, b) => a.file.localeCompare(b.file));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/ci-schedules.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the full suite (shared `src/dev-society/` namespace)**

Run: `node run-all-tests.mjs`
Expected: SUMMARY `red: 0`.

- [ ] **Step 6: Commit**

```bash
git add src/dev-society/ci-schedules.js test/ci-schedules.test.js
git commit -m "feat(ci-schedules): pure parse + normalize + gh-activity enrich"
```

---

### Task 2: `GET /api/ci-schedules` route

**Files:**
- Modify: `src/dashboard/server.js` (add import + route block next to `/api/schedules`)
- Test: `test/ci-schedules-route.test.js`

**Interfaces:**
- Consumes: `listCiSchedules` (Task 1).
- Produces: `GET /api/ci-schedules` → `{ workflows: [...] }` (auth-gated; missing dir → `[]`; missing/corrupt cache → workflows with `—` status).

- [ ] **Step 1: Write the failing test (mirror `test/schedules-route.test.js`'s server+get harness)**

```js
// test/ci-schedules-route.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Reuse the same server bootstrap + authed get() helper that schedules-route.test.js uses.
import { startTestDashboard, get } from './helpers/dashboard-test.js';  // if no shared helper exists, inline the setup from test/schedules-route.test.js

function fixtureRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'ci-sched-'));
  mkdirSync(join(repo, 'dev-mesh'), { recursive: true });               // meshRoot = repo/dev-mesh
  mkdirSync(join(repo, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(repo, '.github', 'workflows', 'integration.yml'),
    "name: Integration (nightly)\non:\n  schedule:\n    - cron: '0 7 * * *'\n  workflow_dispatch:\n");
  return repo;
}

test('GET /api/ci-schedules returns parsed workflows; missing cache → status —', async () => {
  const repo = fixtureRepo();
  const { srv, port, cookie } = await startTestDashboard(join(repo, 'dev-mesh'));  // no gh-activity.json written
  try {
    const r = await get(srv, port, cookie, '/api/ci-schedules');
    assert.equal(r.status, 200);
    assert.equal(r.body.workflows.length, 1);
    assert.equal(r.body.workflows[0].workflow, 'Integration (nightly)');
    assert.equal(r.body.workflows[0].status, null);          // no cache → —
  } finally { srv.close(); rmSync(repo, { recursive: true, force: true }); }
});

test('GET /api/ci-schedules without cookie → 403', async () => {
  const repo = fixtureRepo();
  const { srv, port } = await startTestDashboard(join(repo, 'dev-mesh'));
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/ci-schedules`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' } });
    assert.equal(r.status, 403);
  } finally { srv.close(); rmSync(repo, { recursive: true, force: true }); }
});

test('missing .github/workflows dir → { workflows: [] }', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ci-sched-'));
  mkdirSync(join(repo, 'dev-mesh'), { recursive: true });
  const { srv, port, cookie } = await startTestDashboard(join(repo, 'dev-mesh'));
  try {
    const r = await get(srv, port, cookie, '/api/ci-schedules');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.workflows, []);
  } finally { srv.close(); rmSync(repo, { recursive: true, force: true }); }
});
```

> NOTE: `test/schedules-route.test.js` already bootstraps a dashboard + authed `get()`. If it defines them inline (no shared helper), copy that exact setup into this file instead of importing `./helpers/dashboard-test.js`. Match its cookie/port acquisition verbatim.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/ci-schedules-route.test.js`
Expected: FAIL — route 404/unknown (returns the SPA/index, not `{workflows}`).

- [ ] **Step 3: Add the import (top of `src/dashboard/server.js`, near line 54 with `listAllSchedules`)**

```js
import { listCiSchedules } from '../dev-society/ci-schedules.js';
```

- [ ] **Step 4: Add the route block (immediately after the `/api/schedules` block, ~line 803)**

```js
  // GET /api/ci-schedules → read-only view of GitHub Actions cron workflows
  // (parsed from .github/workflows) enriched with last-run/status from the
  // gh-activity cache. No `gh` calls. Auth-gated by the upstream API gate.
  if (pathname === '/api/ci-schedules' && req.method === 'GET') {
    const wfDir = resolve(meshRoot, '..', '.github', 'workflows');
    let files;
    try {
      files = readdirSync(wfDir)
        .filter((f) => /\.ya?ml$/.test(f))
        .map((f) => ({ name: f, text: readFileSync(join(wfDir, f), 'utf8') }));
    } catch {
      sendJson(res, 200, { workflows: [] });   // no workflows dir → empty
      return;
    }
    const ghActivityPath = process.env.AGENT_MESH_GH_ACTIVITY
      || resolve(meshRoot, '..', '.dev-society', 'gh-activity.json');
    let ghActivity = [];
    try { const p = JSON.parse(readFileSync(ghActivityPath, 'utf8')); if (Array.isArray(p)) ghActivity = p; }
    catch { ghActivity = []; }                  // missing/corrupt cache → still parse files
    sendJson(res, 200, { workflows: listCiSchedules({ files, ghActivity }) });
    return;
  }
```

(Confirm `readdirSync`, `readFileSync`, `resolve`, `join` are already imported in `server.js`; if any is missing, add it to the existing `node:fs`/`node:path` import.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/ci-schedules-route.test.js`
Expected: PASS (3 tests).

- [ ] **Step 6: Run the full suite (shared `server.js`)**

Run: `node run-all-tests.mjs`
Expected: SUMMARY `red: 0`.

- [ ] **Step 7: Commit**

```bash
git add src/dashboard/server.js test/ci-schedules-route.test.js
git commit -m "feat(ci-schedules): read-only GET /api/ci-schedules route"
```

---

### Task 3: SCHEDULES panel — render the "GitHub Actions" group

**Files:**
- Modify: `src/dashboard/public/graph-view.js` (`loadSchedules`)

**Interfaces:**
- Consumes: `GET /api/schedules` (existing) + `GET /api/ci-schedules` (Task 2).

- [ ] **Step 1: Update `loadSchedules` to fetch both routes before the empty check and append a CI group**

Replace the body of `loadSchedules()` in `src/dashboard/public/graph-view.js` with:

```js
async function loadSchedules() {
  let d, ci;
  try { d = await (await fetch('/api/schedules')).json(); } catch { return; }
  try { ci = await (await fetch('/api/ci-schedules')).json(); } catch { ci = { workflows: [] }; }
  const jobs = d.jobs || [];
  const wfs = ci.workflows || [];
  setText('gv-sched-owner', `engine: ${d.schedulerOwner || '—'} · ${jobs.length} mesh · ${wfs.length} CI`);
  const el = root.querySelector('#gv-sched');
  if (!jobs.length && !wfs.length) {
    el.innerHTML = '<div class="gv-empty">No scheduled jobs. Add one to an agent’s .agent/schedule.json (daemon) or a workflow cron.</div>';
    return;
  }
  const pill = (s) => s === 'ok' ? '<span class="state done">ok</span>' : s === 'fail' ? '<span class="state block">fail</span>' : '<span class="state open">—</span>';
  const jobRow = (j) => {
    const desc = j.description ? `<div class="sched-desc" title="${esc(j.description)}">${esc(j.description)}</div>` : '';
    const canRun = j.enabled && !j.running;
    const runBtn = `<button class="sched-run" data-run-agent="${esc(j.agent)}" data-run-id="${esc(j.id)}"${canRun ? '' : ' disabled'} title="${j.enabled ? 'run now (≤30s)' : 'enable the job to run it'}">▶ run</button>`;
    return `<tr><td class="title"><span class="tt"><b class="an" style="color:${agentColor(j.agent)}">${esc(j.agent)}</b> · ${esc(j.name)}</span>${desc}</td><td><span class="kind issue">${esc(j.cadenceLabel || '')}</span></td><td>${j.enabled ? pill(j.lastStatus) : '<span class="state open">off</span>'}</td><td class="age">${esc(j.nextRunAt ? new Date(j.nextRunAt).toLocaleString() : '—')}</td><td class="age">${j.running ? '▶ running' : runBtn}</td></tr>`;
  };
  const ciRow = (w) => `<tr><td class="title"><span class="tt"><b class="an" style="color:#8b949e">GitHub Actions</b> · ${esc(w.workflow)}</span></td><td><span class="kind issue">${esc(w.cadenceLabel || '')}</span></td><td>${w.running ? '<span class="state open">▶ running</span>' : pill(w.status)}</td><td class="age" title="latest cached run (not necessarily a scheduled run)">${esc(w.lastRunAt ? new Date(w.lastRunAt).toLocaleString() : '—')}</td><td class="age">—</td></tr>`;
  const body = jobs.map(jobRow).join('') + wfs.map(ciRow).join('');
  el.innerHTML = `<table><thead><tr><th>executor · job</th><th>cadence</th><th>last</th><th>latest run</th><th></th></tr></thead><tbody>${body}</tbody></table>`;
  el.querySelectorAll('.sched-run').forEach((btn) => btn.addEventListener('click', async () => {
    btn.disabled = true; btn.textContent = 'queued…';
    try {
      await fetch('/api/schedules/run', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: btn.dataset.runAgent, id: btn.dataset.runId }) });
    } catch { /* transient — next poll reflects state */ }
    setTimeout(loadSchedules, 1500);
  }));
}
```

(Note: CI rows have no run button — read-only. Keep the existing `esc`, `setText`, `agentColor`, `root` helpers; only `loadSchedules` changes.)

- [ ] **Step 2: Verify the full suite still green (graph-view.js is browser JS, no unit harness)**

Run: `node run-all-tests.mjs`
Expected: SUMMARY `red: 0`.

- [ ] **Step 3: Manual verification (optional, against the live dashboard)**

The dashboard on `~/.agent-mesh/deploy` will, after this lands on `main` + a dashboard restart, show a "GitHub Actions" group in Graph view → ⏱ SCHEDULES listing the cron workflows with `GitHub Actions · <workflow>` executor. (No automated DOM test exists for this file.)

- [ ] **Step 4: Commit**

```bash
git add src/dashboard/public/graph-view.js
git commit -m "feat(ci-schedules): render GitHub Actions cron group in the SCHEDULES panel"
```

---

## Self-Review

**Spec coverage:**
- §5.1 pure module (parse/normalize/latestCiRuns/listCiSchedules) → Task 1. ✅
- §5.2 read-only auth-gated route + cache/dir fallback → Task 2. ✅
- §5.3 UI: fetch-both-before-empty, CI group, executor, normalized pill, "latest cached run" label, no run button → Task 3. ✅
- §6 tests (parser robustness incl. nested-name/commented/inline-comment/multi/special-char/basename; normalizer; latestCiRuns; listCiSchedules orchestrator-vs-edge-vs-absent; route cookie-gate + cache-missing-still-shows + dir-missing-empty) → Tasks 1 & 2. ✅
- §8 invariants (read-only, additive, degrades-never-throws) → enforced by Tasks 1 (pure, null-tolerant) & 2 (try/catch fallbacks). ✅

**Placeholder scan:** none — complete code in every code step; the one external dependency (the test harness) is explicitly delegated to mirroring `test/schedules-route.test.js` with a verbatim-copy instruction.

**Type consistency:** `listCiSchedules` row shape `{ executor, workflow, file, cron, cadenceLabel, lastRunAt, running, status }` is produced in Task 1 and consumed identically by Task 2's route and Task 3's `ciRow`. `normalizeCiStatus` output (`ok`/`fail`/`null`) matches the `pill()` helper's switch in Task 3. `route.slice(3)` display-name matching is consistent across `latestCiRuns` and the gh-activity shape in Global Constraints.
