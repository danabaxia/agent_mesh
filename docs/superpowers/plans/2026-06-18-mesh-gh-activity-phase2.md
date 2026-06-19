# Mesh GitHub-Activity Poller — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dedicated `orchestrator` agent whose non-claude "builtin" scheduler job polls GitHub Actions and feeds mesh activity, so the dashboard constellation reflects the cloud society's work.

**Architecture:** Add a `builtin` job kind to the Phase-1 scheduler (runs a registered function, not `delegateTask`). A new `gh-activity.js` module maps `gh run list` output → activity records (orchestrator-as-hub). The daemon registers the `gh-activity-poll` builtin; `loadActivitySnapshot` appends the written records before `buildActivity`. A new `orchestrator` agent in `dev-mesh` owns the scheduled job.

**Tech Stack:** Node ≥20, ESM, zero deps, `node --test`. Reuses Phase-1 `createScheduler`, `buildActivity`, the `gh` CLI.

Spec: `docs/superpowers/specs/2026-06-18-mesh-gh-activity-poller-design.md`.

---

## File structure

| File | Responsibility |
|---|---|
| `src/dev-society/gh-activity.js` (new) | pure `workflowToAgent` + `runsToActivityRecords`; impure `pollGhActivity` |
| `src/schedule/scheduler.js` (modify) | `builtins` registry + `kind:'builtin'` dispatch in `executeJob` |
| `scripts/dev-society-daemon.mjs` (modify) | register the `gh-activity-poll` builtin when creating the scheduler |
| `src/dashboard/server.js` (modify) | `loadActivitySnapshot` appends the GH-activity cache records |
| `dev-mesh/orchestrator/{agent.json,AGENT.md,.agent/schedule.json}` (new) + `dev-mesh/mesh.json` (modify) | the orchestrator agent + its builtin poll job |
| `test/gh-activity.test.js`, `test/scheduler-builtin.test.js`, `test/activity-gh-merge.test.js`, `test/orchestrator-agent.test.js` (new) | unit + integration coverage |

---

## Task 1: Pure mapping + records transform (`gh-activity.js`)

**Files:**
- Create: `src/dev-society/gh-activity.js`
- Test: `test/gh-activity.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/gh-activity.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workflowToAgent, runsToActivityRecords } from '../src/dev-society/gh-activity.js';

test('workflowToAgent maps dev-mesh workflows to role agents (catch-all → orchestrator)', () => {
  assert.equal(workflowToAgent('dev-mesh-review'), 'reviewer');
  assert.equal(workflowToAgent('dev-mesh-review-respond'), 'reviewer');
  assert.equal(workflowToAgent('dev-mesh-triage'), 'triager');
  assert.equal(workflowToAgent('dev-mesh-research'), 'analyst');
  assert.equal(workflowToAgent('dev-mesh-intake'), 'analyst');
  assert.equal(workflowToAgent('dev-mesh-backlog'), 'maintainer');
  assert.equal(workflowToAgent('dev-mesh-curate'), 'curator');
  assert.equal(workflowToAgent('dev-mesh-autofix'), 'coder');
  assert.equal(workflowToAgent('dev-mesh-ci-sweep'), 'coder');
  assert.equal(workflowToAgent('dev-mesh-mergefix'), 'coder');
  assert.equal(workflowToAgent('dev-mesh-dogfood'), 'orchestrator');
  assert.equal(workflowToAgent('dev-mesh-pr-janitor'), 'orchestrator');
  assert.equal(workflowToAgent('ci'), 'orchestrator');            // non-dev-mesh → catch-all
});

test('runsToActivityRecords: in-progress run → working node + active orchestrator→agent arc', () => {
  const recs = runsToActivityRecords([
    { databaseId: 5, workflowName: 'dev-mesh-review', status: 'in_progress', conclusion: null, createdAt: '2026-06-18T10:00:00Z', updatedAt: '2026-06-18T10:01:00Z' },
  ]);
  const node = recs.find((r) => r.id === 'gh-5');
  assert.equal(node.agent, 'reviewer');
  assert.equal(node.route, 'ci:dev-mesh-review');
  assert.equal(node.finished_at, undefined);                      // running → no finished_at
  const edge = recs.find((r) => r.id === 'gh-5:e');
  assert.equal(edge.kind, 'a2a'); assert.equal(edge.from, 'orchestrator'); assert.equal(edge.to, 'reviewer');
  assert.equal(edge.status, null); assert.equal(edge.finished_at, undefined);
});

test('runsToActivityRecords: completed run → done node + settled edge with conclusion', () => {
  const recs = runsToActivityRecords([
    { databaseId: 6, workflowName: 'dev-mesh-triage', status: 'completed', conclusion: 'success', createdAt: '2026-06-18T10:00:00Z', updatedAt: '2026-06-18T10:05:00Z' },
  ]);
  assert.equal(recs.find((r) => r.id === 'gh-6').finished_at, '2026-06-18T10:05:00Z');
  const edge = recs.find((r) => r.id === 'gh-6:e');
  assert.equal(edge.to, 'triager'); assert.equal(edge.status, 'success'); assert.equal(edge.finished_at, '2026-06-18T10:05:00Z');
});

test('runsToActivityRecords: orchestrator-owned workflow emits NO self-edge (only node)', () => {
  const recs = runsToActivityRecords([
    { databaseId: 7, workflowName: 'dev-mesh-dogfood', status: 'in_progress', conclusion: null, createdAt: '2026-06-18T10:00:00Z', updatedAt: '2026-06-18T10:00:30Z' },
  ]);
  assert.equal(recs.filter((r) => r.id.startsWith('gh-7')).length, 1);   // node only, no ':e'
  assert.equal(recs[0].agent, 'orchestrator');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/gh-activity.test.js`
Expected: FAIL — `Cannot find module '../src/dev-society/gh-activity.js'`.

- [ ] **Step 3: Write the pure helpers**

```js
// src/dev-society/gh-activity.js
// Pure: map GitHub-Actions workflow runs → mesh activity records (buildActivity
// shape) with the orchestrator as the hub. Impure pollGhActivity (below) runs
// `gh run list` and writes the cache the dashboard's loadActivitySnapshot reads.

// Workflow → role-agent convention (the dev-mesh-<role> naming, prefix stripped).
const ROLE = {
  research: 'analyst', intake: 'analyst', backlog: 'maintainer', triage: 'triager',
  review: 'reviewer', 'review-respond': 'reviewer', curate: 'curator',
  autofix: 'coder', 'ci-sweep': 'coder', mergefix: 'coder',
  dogfood: 'orchestrator', health: 'orchestrator', 'memory-automerge': 'orchestrator', 'pr-janitor': 'orchestrator',
};

export function workflowToAgent(workflowName) {
  const key = String(workflowName || '').replace(/^dev-mesh-/, '');
  return ROLE[key] || 'orchestrator';
}

/**
 * @param {object[]} runs  `gh run list --json …` rows
 * @returns activity records (buildActivity shape). Per run: a node-state record
 *   (agent working/done) and — unless the run maps to the orchestrator itself —
 *   an a2a edge record orchestrator→agent (the hub). finished_at set when done.
 */
export function runsToActivityRecords(runs, { now = () => new Date() } = {}) {
  const out = [];
  for (const r of (Array.isArray(runs) ? runs : [])) {
    if (!r || r.databaseId == null) continue;
    const agent = workflowToAgent(r.workflowName);
    const id = `gh-${r.databaseId}`;
    const completed = r.status === 'completed';
    const finishedAt = completed ? (r.updatedAt || now().toISOString()) : undefined;
    out.push({ id, agent, route: `ci:${r.workflowName || ''}`, started_at: r.createdAt, ...(finishedAt ? { finished_at: finishedAt } : {}) });
    if (agent !== 'orchestrator') {
      out.push({
        id: `${id}:e`, kind: 'a2a', from: 'orchestrator', to: agent, mode: 'ci',
        status: completed ? (r.conclusion || null) : null,
        started_at: r.createdAt, at: r.createdAt, ...(finishedAt ? { finished_at: finishedAt } : {}),
      });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/gh-activity.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/dev-society/gh-activity.js test/gh-activity.test.js
git commit -m "feat(dev-society): pure gh-activity mapping + run→activity-record transform"
```

---

## Task 2: `pollGhActivity` impure runner

**Files:**
- Modify: `src/dev-society/gh-activity.js` (append)
- Test: `test/gh-activity.test.js` (add a case)

- [ ] **Step 1: Add the failing test**

```js
// add to test/gh-activity.test.js
import { pollGhActivity } from '../src/dev-society/gh-activity.js';

test('pollGhActivity: windows recent runs, transforms, writes the cache', async () => {
  const nowMs = Date.parse('2026-06-18T12:00:00Z');
  const gh = async (args) => {
    assert.ok(args.includes('run') && args.includes('list'));
    return JSON.stringify([
      { databaseId: 1, workflowName: 'dev-mesh-review', status: 'in_progress', conclusion: null, createdAt: '2026-06-18T11:59:00Z', updatedAt: '2026-06-18T11:59:30Z' },
      { databaseId: 2, workflowName: 'dev-mesh-triage', status: 'completed', conclusion: 'success', createdAt: '2026-06-18T05:00:00Z', updatedAt: '2026-06-18T05:10:00Z' }, // stale → dropped (>120m)
    ]);
  };
  let written = null;
  const r = await pollGhActivity({ gh, repo: 'o/r', writeCache: async (recs) => { written = recs; }, now: () => new Date(nowMs), windowMin: 120 });
  assert.equal(r.status, 'ok');
  // only run 1 is within the 120-min window → its node + edge (2 records)
  assert.equal(written.length, 2);
  assert.ok(written.every((rec) => rec.id.startsWith('gh-1')));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/gh-activity.test.js` → the new test FAILS (`pollGhActivity` not exported).

- [ ] **Step 3: Append `pollGhActivity` to `src/dev-society/gh-activity.js`**

```js
const GH_FIELDS = 'databaseId,workflowName,status,conclusion,createdAt,updatedAt,event,headBranch';

/**
 * Impure: run `gh run list`, keep a recent window, transform, write the cache.
 * `gh(args) → stdout`, `writeCache(records) → void`. Returns the builtin-runner
 * result shape ({status:'ok'|'fail', output?/error?}).
 */
export async function pollGhActivity({ gh, repo, writeCache, now = () => new Date(), windowMin = Number(process.env.GH_ACTIVITY_WINDOW_MIN) || 120 }) {
  try {
    const runs = JSON.parse(await gh(['run', 'list', '--repo', repo, '--limit', '80', '--json', GH_FIELDS]));
    const cut = now().getTime() - windowMin * 60_000;
    const recent = (Array.isArray(runs) ? runs : []).filter((r) => {
      const t = Date.parse(r.updatedAt || r.createdAt || '');
      return Number.isFinite(t) && t >= cut;
    });
    const records = runsToActivityRecords(recent, { now });
    await writeCache(records);
    return { status: 'ok', output: `gh-activity: ${records.length} records from ${recent.length} runs` };
  } catch (e) {
    return { status: 'fail', error: e?.message || String(e) };
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/gh-activity.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/dev-society/gh-activity.js test/gh-activity.test.js
git commit -m "feat(dev-society): pollGhActivity — windowed gh run poll → activity cache"
```

---

## Task 3: Scheduler `builtin` job kind

**Files:**
- Modify: `src/schedule/scheduler.js`
- Test: `test/scheduler-builtin.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/scheduler-builtin.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScheduler } from '../src/schedule/scheduler.js';
import { writeManifest } from '../src/builder/manifest.js';

async function mesh(job) {
  const root = await mkdtemp(join(tmpdir(), 'sched-builtin-'));
  const a = join(root, 'orchestrator');
  await mkdir(join(a, '.agent'), { recursive: true });
  await writeFile(join(a, '.agent', 'schedule.json'), JSON.stringify({ jobs: [job] }), 'utf8');
  await writeManifest(root, { meshVersion: '0.1.0', agents: [{ name: 'orchestrator', root: './orchestrator', card: 'agent.json', served: true, enabledModes: ['ask'], peers: [] }] });
  return { root, a };
}

test('builtin job runs the registered fn (not delegateTask); state records ok', async () => {
  let ran = 0;
  const { root, a } = await mesh({ id: 'p', name: 'poll', kind: 'builtin', builtin: 'gh-activity-poll', cadence: { kind: 'every', minutes: 5 }, enabled: true });
  // Pre-seed state so the job is due (nextRunAt in the past).
  await writeFile(join(a, '.agent-mesh', 'schedule-state.json'), JSON.stringify({ p: { nextRunAt: '2000-01-01T00:00:00Z' } }), 'utf8').catch(async () => {
    await mkdir(join(a, '.agent-mesh'), { recursive: true });
    await writeFile(join(a, '.agent-mesh', 'schedule-state.json'), JSON.stringify({ p: { nextRunAt: '2000-01-01T00:00:00Z' } }), 'utf8');
  });
  const sched = createScheduler({ meshRoot: root, builtins: { 'gh-activity-poll': async () => { ran++; return { status: 'ok', output: 'done' }; } } });
  await sched.tick();
  assert.equal(ran, 1);
  const state = JSON.parse(await readFile(join(a, '.agent-mesh', 'schedule-state.json'), 'utf8'));
  assert.equal(state.p.lastStatus, 'ok');
});

test('unknown builtin → fail state, never throws', async () => {
  const { root, a } = await mesh({ id: 'p', name: 'poll', kind: 'builtin', builtin: 'nope', cadence: { kind: 'every', minutes: 5 }, enabled: true });
  await mkdir(join(a, '.agent-mesh'), { recursive: true });
  await writeFile(join(a, '.agent-mesh', 'schedule-state.json'), JSON.stringify({ p: { nextRunAt: '2000-01-01T00:00:00Z' } }), 'utf8');
  const sched = createScheduler({ meshRoot: root, builtins: {} });
  await sched.tick();
  const state = JSON.parse(await readFile(join(a, '.agent-mesh', 'schedule-state.json'), 'utf8'));
  assert.equal(state.p.lastStatus, 'fail');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/scheduler-builtin.test.js`
Expected: FAIL — builtin jobs aren't dispatched (the default delegate `run` is called, which tries `delegateTask` and behaves differently / the `ran` counter stays 0).

- [ ] **Step 3: Add the `builtins` registry + dispatch**

In `src/schedule/scheduler.js`, change the `createScheduler` signature to accept `builtins`:
```js
export function createScheduler({ meshRoot, runJob, builtins = {}, intervalMs = DEFAULT_INTERVAL_MS, now = () => new Date() }) {
```
In `executeJob`, replace the single delegate call:
```js
        const result = await run({ agentRoot: agent.root, agentName: agent.name, job });
```
with builtin-aware dispatch:
```js
        const result = job.kind === 'builtin'
          ? (typeof builtins[job.builtin] === 'function'
              ? await builtins[job.builtin]({ agentRoot: agent.root, agentName: agent.name, job, meshRoot: root })
              : { status: 'fail', error: `unknown builtin: ${job.builtin}` })
          : await run({ agentRoot: agent.root, agentName: agent.name, job });
```
(`root` is the resolved meshRoot already in scope from `const root = resolve(meshRoot);`.)

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/scheduler-builtin.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the existing scheduler tests (no regression)**

Run: `node --test test/scheduler.test.js`
Expected: PASS (claude/delegate jobs unaffected — the `kind:'builtin'` branch is only taken for builtin jobs).

- [ ] **Step 6: Commit**

```bash
git add src/schedule/scheduler.js test/scheduler-builtin.test.js
git commit -m "feat(schedule): builtin job kind — run a registered fn instead of delegateTask"
```

---

## Task 4: Daemon registers the `gh-activity-poll` builtin

**Files:**
- Modify: `scripts/dev-society-daemon.mjs`
- Test: `test/orchestrator-agent.test.js` (source-shape part; full file in Task 6 — here add the daemon-wiring assertions)

- [ ] **Step 1: Create `test/orchestrator-agent.test.js` with the daemon-wiring lint**

```js
// test/orchestrator-agent.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const daemon = readFileSync(fileURLToPath(new URL('../scripts/dev-society-daemon.mjs', import.meta.url)), 'utf8');

test('daemon registers the gh-activity-poll builtin with the scheduler', () => {
  assert.match(daemon, /pollGhActivity/, 'imports/uses pollGhActivity');
  assert.match(daemon, /'gh-activity-poll'/, 'registers the gh-activity-poll builtin');
  assert.match(daemon, /createScheduler\([^)]*builtins/s, 'passes builtins to createScheduler');
  assert.match(daemon, /AGENT_MESH_GH_ACTIVITY|gh-activity\.json/, 'has a gh-activity cache path');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/orchestrator-agent.test.js`
Expected: FAIL — the daemon doesn't register the builtin yet.

- [ ] **Step 3: Wire the builtin into the daemon**

In `scripts/dev-society-daemon.mjs`:
(a) Add to the `node:fs` import (it imports `{ mkdirSync, appendFileSync, rmSync, existsSync, realpathSync }`) → add `writeFileSync`:
```js
import { mkdirSync, appendFileSync, rmSync, existsSync, realpathSync, writeFileSync } from 'node:fs';
```
(b) Add the import (next to `import { createScheduler } from '../src/schedule/scheduler.js';`):
```js
import { pollGhActivity } from '../src/dev-society/gh-activity.js';
```
(c) Where the scheduler is created (the `if (!once && !selftest)` block from Phase 1), register the builtin. Replace the `createScheduler({ meshRoot: SCHED_MESH_ROOT })` call with:
```js
  const ghActivityPath = process.env.AGENT_MESH_GH_ACTIVITY || join(repoRoot, '.dev-society', 'gh-activity.json');
  const builtins = {
    'gh-activity-poll': () => pollGhActivity({
      gh: async (args) => (await sh('gh', args, { maxBuffer: 1 << 24 })).stdout,
      repo: cfg.repo,
      writeCache: (records) => { mkdirSync(dirname(ghActivityPath), { recursive: true }); writeFileSync(ghActivityPath, JSON.stringify(records)); },
    }),
  };
  sched = createScheduler({ meshRoot: SCHED_MESH_ROOT, builtins });
```
(`sh`, `cfg`, `dirname`, `join`, `repoRoot`, `SCHED_MESH_ROOT` are all already in scope from the existing daemon.)

- [ ] **Step 4: Run the wiring test + selftest (still side-effect-free)**

Run: `node --test test/orchestrator-agent.test.js` (the daemon-wiring test) → PASS.
Run: `DEV_SOCIETY_REPO=x node scripts/dev-society-daemon.mjs --selftest` → exits 0, prints `selftest OK`, no scheduler start.

- [ ] **Step 5: Commit**

```bash
git add scripts/dev-society-daemon.mjs test/orchestrator-agent.test.js
git commit -m "feat(dev-society): register gh-activity-poll builtin in the daemon scheduler"
```

---

## Task 5: `loadActivitySnapshot` appends the GH-activity cache

**Files:**
- Modify: `src/dashboard/server.js`
- Test: `test/activity-gh-merge.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/activity-gh-merge.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDashboardServer } from '../src/dashboard/server.js';
import { initMesh } from '../src/builder/init-mesh.js';
import { writeManifest } from '../src/builder/manifest.js';

test('GET /api/activity includes GitHub-Actions records from the gh-activity cache', async () => {
  const meshRoot = await mkdtemp(join(tmpdir(), 'ghmerge-'));
  await initMesh(meshRoot);
  await mkdir(join(meshRoot, 'reviewer'), { recursive: true });
  await writeFile(join(meshRoot, 'reviewer', 'agent.json'), JSON.stringify({ name: 'reviewer' }), 'utf8');
  await writeManifest(meshRoot, { meshVersion: '0.1.0', agents: [{ name: 'reviewer', root: './reviewer', card: 'agent.json', served: true, enabledModes: ['ask'], peers: [] }] });
  // plant the cache at the default location: <meshRoot>/../.dev-society/gh-activity.json
  const cacheDir = resolve(meshRoot, '..', '.dev-society');
  await mkdir(cacheDir, { recursive: true });
  await writeFile(join(cacheDir, 'gh-activity.json'), JSON.stringify([
    { id: 'gh-9', agent: 'reviewer', route: 'ci:dev-mesh-review', started_at: '2026-06-18T10:00:00Z' },
    { id: 'gh-9:e', kind: 'a2a', from: 'orchestrator', to: 'reviewer', mode: 'ci', status: null, started_at: '2026-06-18T10:00:00Z', at: '2026-06-18T10:00:00Z' },
  ]), 'utf8');

  const srv = createDashboardServer({ meshRoot, port: 0 });
  await srv.start(); const port = new URL(srv.url).port;
  const boot = await fetch(`${srv.url}/?t=${srv.token}`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'none' }, redirect: 'manual' });
  const cookie = `am_dash=${boot.headers.get('set-cookie').match(/am_dash=([^;]+)/)[1]}`;
  try {
    const r = await fetch(`${srv.url}/api/activity`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie } });
    const body = await r.json();
    assert.ok(body.edges.some((e) => e.from === 'orchestrator' && e.to === 'reviewer' && e.active === true), 'orchestrator→reviewer active edge present');
    assert.ok(body.agents.some((a) => a.name === 'reviewer' && a.state === 'working'), 'reviewer node working from the gh node record');
  } finally { await srv.close(); }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/activity-gh-merge.test.js`
Expected: FAIL — `/api/activity` has no orchestrator→reviewer edge (cache not merged).

- [ ] **Step 3: Append the cache in `loadActivitySnapshot`**

In `src/dashboard/server.js`, find `async function loadActivitySnapshot(meshRoot) {`. Just before its final `return buildActivity(records);`, add:
```js
  // Append GitHub-Actions activity (written by the orchestrator's gh-activity-poll
  // builtin). Records are pre-shaped to buildActivity's contract; keep agent/from/to
  // as-is (do NOT re-tag like per-agent logs). Missing/corrupt cache → local-only.
  const ghActivityPath = process.env.AGENT_MESH_GH_ACTIVITY
    || resolve(meshRoot, '..', '.dev-society', 'gh-activity.json');
  try {
    const gh = JSON.parse(await readFile(ghActivityPath, 'utf8'));
    if (Array.isArray(gh)) for (const r of gh) records.push(r);
  } catch { /* no cache / unreadable → local activity only */ }
```
(`readFile` from `node:fs/promises` and `resolve` from `node:path` are already imported in server.js.)

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/activity-gh-merge.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/server.js test/activity-gh-merge.test.js
git commit -m "feat(dashboard): merge gh-activity cache into /api/activity (orchestrator hub)"
```

---

## Task 6: Add the `orchestrator` agent to dev-mesh

**Files:**
- Create: `dev-mesh/orchestrator/agent.json`, `dev-mesh/orchestrator/AGENT.md`, `dev-mesh/orchestrator/.agent/schedule.json`
- Modify: `dev-mesh/mesh.json`
- Test: `test/orchestrator-agent.test.js` (add the config assertions)

- [ ] **Step 1: Add the config assertions to `test/orchestrator-agent.test.js`**

```js
// add to test/orchestrator-agent.test.js
import { fileURLToPath as fp } from 'node:url';
const repo = (p) => readFileSync(fp(new URL('../' + p, import.meta.url)), 'utf8');

test('orchestrator agent is registered in dev-mesh with the gh-activity-poll builtin', () => {
  const mesh = JSON.parse(repo('dev-mesh/mesh.json'));
  const orch = (mesh.agents || []).find((a) => a.name === 'orchestrator');
  assert.ok(orch, 'orchestrator present in mesh.json');
  assert.equal(orch.served, true);
  const sched = JSON.parse(repo('dev-mesh/orchestrator/.agent/schedule.json'));
  const job = (sched.jobs || []).find((j) => j.builtin === 'gh-activity-poll');
  assert.ok(job, 'gh-activity-poll job present');
  assert.equal(job.kind, 'builtin');
  assert.equal(job.cadence.kind, 'every');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/orchestrator-agent.test.js`
Expected: FAIL — no `orchestrator` in `mesh.json` / no schedule.json.

- [ ] **Step 3: Create the agent files**

`dev-mesh/orchestrator/agent.json`:
```json
{
  "name": "orchestrator",
  "description": "Mesh orchestrator — observes the society's GitHub-Actions activity and keeps the scheduled ops healthy.",
  "x-agentmesh": { "modes": ["ask"], "meshVersion": "0.1.0" }
}
```

`dev-mesh/orchestrator/AGENT.md`:
```markdown
# orchestrator

Mesh ops / observability. Watches the society's GitHub-Actions runs and surfaces
them as live mesh activity; owns the scheduled `gh-activity-poll` (and, later, the
mesh-level self-healing heartbeat). Read-only — never writes code or merges.
```

`dev-mesh/orchestrator/.agent/schedule.json`:
```json
{
  "jobs": [
    {
      "id": "gh-activity-poll",
      "name": "GitHub activity poll",
      "kind": "builtin",
      "builtin": "gh-activity-poll",
      "cadence": { "kind": "every", "minutes": 5 },
      "enabled": true
    }
  ]
}
```

(Cadence `every 5` keeps `gh` calls modest; the spec's "every 2m" target can be tuned later via the file.)

- [ ] **Step 4: Add `orchestrator` to `dev-mesh/mesh.json`**

Add this object to the `agents` array in `dev-mesh/mesh.json` (after `curator`):
```json
    {
      "name": "orchestrator",
      "root": "./orchestrator",
      "card": "agent.json",
      "served": true,
      "enabledModes": ["ask"],
      "peers": []
    }
```

- [ ] **Step 5: Seed scaffold + validate conformance**

Run: `node ./bin/agent-mesh.js doctor dev-mesh --apply 2>&1 | tail -5`
Expected: seeds `dev-mesh/orchestrator/prompts/*` and `.agent/*` scaffold (does NOT touch `schedule.json`).
Run: `node ./bin/agent-mesh.js validate dev-mesh 2>&1 | grep -E 'FAIL|Conformance'`
Expected: `Conformance: OK` (no FAIL lines).
Run: `node --test test/orchestrator-agent.test.js`
Expected: PASS.

- [ ] **Step 6: Commit (committed agent CONTENT only — generated wiring stays gitignored)**

```bash
git add dev-mesh/mesh.json dev-mesh/orchestrator/agent.json dev-mesh/orchestrator/AGENT.md dev-mesh/orchestrator/.agent/schedule.json dev-mesh/orchestrator/prompts dev-mesh/orchestrator/.agent/*/.gitkeep dev-mesh/orchestrator/deliverables dev-mesh/orchestrator/output
git commit -m "feat(dev-mesh): add the orchestrator agent + its gh-activity-poll job"
```

---

## Task 7: Full-suite verification + live check

- [ ] **Step 1: Run the whole suite**

Run: `npm test`
Expected: PASS — all existing + new (`gh-activity` 5, `scheduler-builtin` 2, `activity-gh-merge` 1, `orchestrator-agent` 3); 0 failures, 9 pre-existing skips.

- [ ] **Step 2: Live smoke — the poll writes a cache and /api/activity reflects it**

```bash
# one mechanical poll against the real repo (read-only gh), then check the cache
node -e "import('./src/dev-society/gh-activity.js').then(async m=>{ const {execFile}=await import('node:child_process'); const {promisify}=await import('node:util'); const sh=promisify(execFile); const fs=await import('node:fs'); const r=await m.pollGhActivity({ gh:async a=>(await sh('gh',a,{maxBuffer:1<<24})).stdout, repo:'danabaxia/agent_mesh', writeCache:recs=>fs.writeFileSync('.dev-society/gh-activity.json', JSON.stringify(recs)) }); console.log(r); });"
ls -la .dev-society/gh-activity.json
```
Expected: `{ status: 'ok', output: 'gh-activity: N records from M runs' }` and a written cache (N≥0 depending on recent CI activity).

- [ ] **Step 3: Commit (empty if clean)**

```bash
git commit --allow-empty -m "test(gh-activity): Phase 2 verified (npm test green + live poll)"
```

---

## Self-review notes (author)

- **Spec component 1 (orchestrator agent)** → Task 6. ✓
- **Component 2 (builtin job kind)** → Task 3. ✓
- **Component 3 (gh-activity-poll runner)** → Tasks 1 (pure) + 2 (`pollGhActivity`) + 4 (daemon registers it). ✓
- **Component 4 (activity merge)** → Task 5 (`loadActivitySnapshot` append). ✓
- **Activity records (two-per-run, self-loop guard)** → Task 1 (`runsToActivityRecords`, orchestrator-skip-edge test). ✓ (buildActivity also drops `from===to`, but the guard avoids a spurious self a2a *event*.)
- **Mapping table** → Task 1 (`workflowToAgent`, every arm tested). ✓
- **Window + dedup** → Task 2 (windowMin filter; cache rewritten in full each poll = inherent dedup). ✓
- **Safety (read-only, no secrets, tolerant merge)** → records carry only metadata; Task 5 try/catch degrades to local-only. ✓
- **Naming consistency:** `workflowToAgent`, `runsToActivityRecords`, `pollGhActivity`, `builtins`, `gh-activity-poll`, `AGENT_MESH_GH_ACTIVITY`, `ghActivityPath` — identical across tasks.
- **Deferred:** Phase 3 heartbeat (separate spec).
