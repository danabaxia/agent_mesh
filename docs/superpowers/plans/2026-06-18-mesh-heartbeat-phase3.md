# Mesh Self-Healing Heartbeat — Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single mesh-level heartbeat loop in the dev-society daemon that scans every agent's scheduled-job health, surfaces it on the dashboard (`/api/health`), applies minimal-safe self-heal (clear stale lock, re-arm overdue), and escalates persistent problems to a de-duped GitHub issue.

**Architecture:** Pure core (`assessMeshHealth`) classifies the mesh-wide schedule list into findings/heals/escalations with zero I/O; an impure runner (`runHeartbeat`) wires it to fs + `gh`. The daemon runs it as a third `setInterval` loop. A tiny scheduler change adds a `consecutiveFailures` counter (builtin jobs write no run-log, so failure streaks must live in state). The dashboard reads the snapshot read-only.

**Tech Stack:** Node ≥20, ESM, zero deps, `node --test`. Reuses Phase-1 `listAllSchedules`/`computeNextRun`, the daemon's `gh` helpers, and the Phase-2 dashboard cache-merge + daemon-lint test patterns.

Spec: `docs/superpowers/specs/2026-06-18-mesh-heartbeat-phase3-design.md`.

---

## File structure

| File | Responsibility |
|---|---|
| `src/schedule/scheduler.js` (modify) | write `consecutiveFailures` to schedule-state (++ on fail, 0 on ok) |
| `src/schedule/list-all.js` (modify) | surface `consecutiveFailures` in the mesh-wide job list |
| `src/mesh-health/heartbeat.js` (new) | PURE `assessMeshHealth` — classify jobs → findings/heals/escalations |
| `src/mesh-health/heartbeat-runner.js` (new) | IMPURE `runHeartbeat` — gather → assess → heal → snapshot → escalate |
| `src/config.js` (modify) | heartbeat threshold/interval defaults |
| `scripts/dev-society-daemon.mjs` (modify) | third loop: heartbeat tick + `applyHeal`/`openIssue`/`writeSnapshot` wiring |
| `src/dashboard/server.js` (modify) | `GET /api/health` (read-only snapshot) |
| `src/dashboard/public/graph-view.js` (modify) | foldable Health panel |
| `test/{scheduler-failcount,heartbeat-assess,heartbeat-runner,heartbeat-daemon,health-route}.test.js` (new) | coverage |

---

## Task 1: `consecutiveFailures` counter in the scheduler

**Files:**
- Modify: `src/schedule/scheduler.js` (the post-run state write, ~lines 211–218)
- Modify: `src/schedule/list-all.js` (the `jobs.push({...})` shape, ~lines 31–44)
- Test: `test/scheduler-failcount.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/scheduler-failcount.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScheduler } from '../src/schedule/scheduler.js';
import { initMesh } from '../src/builder/init-mesh.js';
import { writeManifest } from '../src/builder/manifest.js';

// Build a one-agent mesh whose single builtin job is due now, with an injected
// builtin fn whose result we control per tick.
async function meshWithDueJob() {
  const root = await mkdtemp(join(tmpdir(), 'sched-failcount-'));
  await initMesh(root);
  const a = join(root, 'orchestrator');
  await mkdir(join(a, '.agent'), { recursive: true });
  await writeFile(join(a, '.agent', 'schedule.json'),
    JSON.stringify({ jobs: [{ id: 'p', name: 'poll', kind: 'builtin', builtin: 'probe', cadence: { kind: 'every', minutes: 5 }, enabled: true }] }), 'utf8');
  await writeManifest(root, { meshVersion: '0.1.0', agents: [{ name: 'orchestrator', root: './orchestrator', card: 'agent.json', served: true, enabledModes: ['ask'], peers: [] }] });
  await mkdir(join(a, '.agent-mesh'), { recursive: true });
  await writeFile(join(a, '.agent-mesh', 'schedule-state.json'), JSON.stringify({ p: { nextRunAt: '2000-01-01T00:00:00Z' } }), 'utf8');
  return { root, statePath: join(a, '.agent-mesh', 'schedule-state.json') };
}
const readState = async (p) => JSON.parse(await readFile(p, 'utf8'));

test('consecutiveFailures increments on fail, resets on ok, defaults to 0', async () => {
  const { root, statePath } = await meshWithDueJob();
  let outcome = { status: 'fail', error: 'boom' };
  const sched = createScheduler({ meshRoot: root, builtins: { probe: async () => outcome } });

  await sched.tick();
  let st = await readState(statePath);
  assert.equal(st.p.lastStatus, 'fail');
  assert.equal(st.p.consecutiveFailures, 1);

  // Force it due again, fail again → 2.
  st.p.nextRunAt = '2000-01-01T00:00:00Z'; await writeFile(statePath, JSON.stringify(st), 'utf8');
  await sched.tick();
  st = await readState(statePath);
  assert.equal(st.p.consecutiveFailures, 2);

  // Now succeed → reset to 0.
  outcome = { status: 'ok', output: 'fine' };
  st.p.nextRunAt = '2000-01-01T00:00:00Z'; await writeFile(statePath, JSON.stringify(st), 'utf8');
  await sched.tick();
  st = await readState(statePath);
  assert.equal(st.p.lastStatus, 'ok');
  assert.equal(st.p.consecutiveFailures, 0);
});
```

NOTE: VERIFY the harness against the real engine (`test/scheduler-builtin.test.js` is the closest sibling — copy its exact `initMesh`/`writeManifest`/inject-clock conventions). If a pinned `now` is required to keep the job due/deterministic, add `now` to `createScheduler({...})` as that sibling does and advance/pin it between ticks. Preserve the three assertions (1 → 2 → reset-to-0).

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/scheduler-failcount.test.js`
Expected: FAIL — `st.p.consecutiveFailures` is `undefined` (not written yet).

- [ ] **Step 3: Write `consecutiveFailures` in the post-run state**

In `src/schedule/scheduler.js`, the post-run state object (currently ~lines 211–218):
```js
      const after = {
        ...state[job.id],
        lastRunAt: startedAt.toISOString(),
        lastStatus: ok ? 'ok' : 'fail',
        lastSummary: String(summarySource).slice(0, SUMMARY_CAP),
        nextRunAt: computeNextRun(job.cadence, finishedAt).toISOString(),
        running: false
      };
```
Add one line that derives the counter from the prior state (`state[job.id]` is the pre-run entry already in scope here):
```js
      const after = {
        ...state[job.id],
        lastRunAt: startedAt.toISOString(),
        lastStatus: ok ? 'ok' : 'fail',
        lastSummary: String(summarySource).slice(0, SUMMARY_CAP),
        nextRunAt: computeNextRun(job.cadence, finishedAt).toISOString(),
        consecutiveFailures: ok ? 0 : ((state[job.id]?.consecutiveFailures || 0) + 1),
        running: false
      };
```
(Use the REAL variable names you find — the object may be named `after` or written inline; match the file. The counter reads the pre-run `consecutiveFailures` and resets on `ok`, increments on `fail`.)

- [ ] **Step 4: Surface it in `list-all.js`**

In `src/schedule/list-all.js`, the `jobs.push({...})` object (~lines 31–44), add one field:
```js
        running: !!e.running,
        consecutiveFailures: e.consecutiveFailures ?? 0,
```

- [ ] **Step 5: Run to verify it passes + no regression**

Run: `node --test test/scheduler-failcount.test.js` → PASS.
Run: `node --test test/scheduler.test.js test/scheduler-builtin.test.js` → PASS (no regression; the new field is additive).

- [ ] **Step 6: Commit**

```bash
git add src/schedule/scheduler.js src/schedule/list-all.js test/scheduler-failcount.test.js
git commit -m "feat(schedule): track consecutiveFailures in schedule-state (heartbeat input)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Pure `assessMeshHealth`

**Files:**
- Create: `src/mesh-health/heartbeat.js`
- Test: `test/heartbeat-assess.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/heartbeat-assess.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessMeshHealth } from '../src/mesh-health/heartbeat.js';

const NOW = new Date('2026-06-18T12:00:00Z');
const TH = { failThreshold: 3, overdueGraceMs: 900_000, staleMs: 1_800_000, escalateAfter: 2 };
const base = { agent: 'orchestrator', id: 'p', enabled: true, cadence: { kind: 'every', minutes: 5 }, running: false, lastStatus: 'ok', lastRunAt: '2026-06-18T11:59:00Z', nextRunAt: '2026-06-18T11:59:00Z', consecutiveFailures: 0 };

test('healthy job → ok, no findings/heals/escalations', () => {
  const r = assessMeshHealth({ jobs: [{ ...base, nextRunAt: '2026-06-18T12:04:00Z' }], now: NOW, thresholds: TH });
  assert.equal(r.summary.ok, 1);
  assert.equal(r.findings.length, 0);
  assert.equal(r.heals.length, 0);
  assert.equal(r.escalations.length, 0);
});

test('disabled job is never assessed (counts ok)', () => {
  const r = assessMeshHealth({ jobs: [{ ...base, enabled: false, running: true, lastRunAt: '2020-01-01T00:00:00Z' }], now: NOW, thresholds: TH });
  assert.equal(r.findings.length, 0);
  assert.equal(r.summary.ok, 1);
});

test('stuck: running with stale lastRunAt → clear_stale heal', () => {
  const r = assessMeshHealth({ jobs: [{ ...base, running: true, lastRunAt: '2026-06-18T11:00:00Z' }], now: NOW, thresholds: TH });
  assert.equal(r.findings[0].condition, 'stuck');
  assert.deepEqual(r.heals[0], { agent: 'orchestrator', jobId: 'p', action: 'clear_stale', reason: r.heals[0].reason });
  assert.equal(r.summary.stuck, 1);
});

test('overdue: not running, nextRunAt far past → rearm heal', () => {
  const r = assessMeshHealth({ jobs: [{ ...base, nextRunAt: '2026-06-18T11:00:00Z' }], now: NOW, thresholds: TH });
  assert.equal(r.findings[0].condition, 'overdue');
  assert.equal(r.heals[0].action, 'rearm');
});

test('failing: consecutiveFailures ≥ threshold → no heal (escalation path only)', () => {
  const r = assessMeshHealth({ jobs: [{ ...base, lastStatus: 'fail', consecutiveFailures: 3, nextRunAt: '2026-06-18T12:04:00Z' }], now: NOW, thresholds: TH });
  assert.equal(r.findings[0].condition, 'failing');
  assert.equal(r.findings[0].consecutiveFailures, 3);
  assert.equal(r.heals.length, 0);
});

test('precedence: stuck > failing > overdue', () => {
  const j = { ...base, running: true, lastRunAt: '2026-06-18T11:00:00Z', consecutiveFailures: 9, nextRunAt: '2026-06-18T10:00:00Z' };
  const r = assessMeshHealth({ jobs: [j], now: NOW, thresholds: TH });
  assert.equal(r.findings[0].condition, 'stuck');
});

test('seenCount carries from prev; escalates at escalateAfter (open then update); closes on recovery', () => {
  const job = [{ ...base, nextRunAt: '2026-06-18T11:00:00Z' }]; // overdue
  // tick 1: first sight → warn, seenCount 1, no escalation
  const r1 = assessMeshHealth({ jobs: job, now: NOW, thresholds: TH, prev: null });
  assert.equal(r1.findings[0].seenCount, 1);
  assert.equal(r1.findings[0].severity, 'warn');
  assert.equal(r1.escalations.length, 0);
  // tick 2: seenCount 2 ≥ escalateAfter → error + open
  const r2 = assessMeshHealth({ jobs: job, now: NOW, thresholds: TH, prev: r1 });
  assert.equal(r2.findings[0].seenCount, 2);
  assert.equal(r2.findings[0].severity, 'error');
  assert.equal(r2.escalations[0].action, 'open');
  assert.deepEqual(r2.openEscalations, ['mesh-heartbeat:orchestrator/p/overdue']);
  // tick 3: still overdue → update (already open)
  const r3 = assessMeshHealth({ jobs: job, now: NOW, thresholds: TH, prev: r2 });
  assert.equal(r3.escalations[0].action, 'update');
  // tick 4: recovered (healthy) → close, openEscalations empties
  const r4 = assessMeshHealth({ jobs: [{ ...base, nextRunAt: '2026-06-18T12:04:00Z' }], now: NOW, thresholds: TH, prev: r3 });
  assert.equal(r4.escalations[0].action, 'close');
  assert.equal(r4.escalations[0].key, 'mesh-heartbeat:orchestrator/p/overdue');
  assert.deepEqual(r4.openEscalations, []);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/heartbeat-assess.test.js`
Expected: FAIL — `Cannot find module '../src/mesh-health/heartbeat.js'`.

- [ ] **Step 3: Write `src/mesh-health/heartbeat.js`**

```js
// Pure: classify the mesh-wide schedule list into health findings, the
// minimal-safe heals to apply, and the de-duped GitHub-issue escalations.
// Zero I/O — the only clock is the injected `now`. The impure runner
// (heartbeat-runner.js) feeds it `listAllSchedules` jobs + the prev snapshot.

const keyOf = (agent, jobId, condition) => `mesh-heartbeat:${agent}/${jobId}/${condition}`;

function classify(j, t, { staleMs, overdueGraceMs, failThreshold }) {
  const running = j.running === true;
  const lastRunMs = Date.parse(j.lastRunAt || '');
  const nextRunMs = Date.parse(j.nextRunAt || '');
  if (running && Number.isFinite(lastRunMs) && (t - lastRunMs) > staleMs) return 'stuck';
  if ((j.consecutiveFailures || 0) >= failThreshold) return 'failing';
  if (!running && Number.isFinite(nextRunMs) && (t - nextRunMs) > overdueGraceMs) return 'overdue';
  return null;
}

function detailFor(j, condition) {
  if (condition === 'stuck') return `running since ${j.lastRunAt} (stale lock)`;
  if (condition === 'failing') return `${j.consecutiveFailures} consecutive failures; last: ${j.lastSummary || j.lastStatus}`;
  if (condition === 'overdue') return `nextRunAt ${j.nextRunAt} is overdue and not arming`;
  return '';
}

/**
 * @param {object} args
 * @param {object[]} args.jobs  listAllSchedules().jobs (mesh-wide)
 * @param {Date}     args.now
 * @param {object}   args.thresholds  { failThreshold, overdueGraceMs, staleMs, escalateAfter }
 * @param {object|null} args.prev  previous snapshot { findings, openEscalations } (or null)
 * @returns {{ findings:object[], heals:object[], escalations:object[], openEscalations:string[], summary:object }}
 */
export function assessMeshHealth({ jobs, now = new Date(), thresholds = {}, prev = null }) {
  const { failThreshold = 3, overdueGraceMs = 900_000, staleMs = 1_800_000, escalateAfter = 2 } = thresholds;
  const t = now.getTime();
  const prevFindings = new Map((prev?.findings ?? []).map((f) => [keyOf(f.agent, f.jobId, f.condition), f]));
  const prevOpen = new Set(prev?.openEscalations ?? []);

  const findings = [], heals = [], escalations = [];
  const summary = { ok: 0, failing: 0, overdue: 0, stuck: 0, escalated: 0 };
  const nextOpen = new Set();

  for (const j of (Array.isArray(jobs) ? jobs : [])) {
    if (!j || j.enabled === false) { summary.ok++; continue; }
    const condition = classify(j, t, { staleMs, overdueGraceMs, failThreshold });
    if (!condition) { summary.ok++; continue; }
    summary[condition]++;

    const key = keyOf(j.agent, j.id, condition);
    const prevF = prevFindings.get(key);
    const seenCount = (prevF?.seenCount ?? 0) + 1;
    const since = prevF?.since ?? now.toISOString();
    const severity = seenCount >= escalateAfter ? 'error' : 'warn';
    const detail = detailFor(j, condition);
    findings.push({
      agent: j.agent, jobId: j.id, condition, severity, detail, since, seenCount,
      ...(condition === 'failing' ? { consecutiveFailures: j.consecutiveFailures || 0 } : {}),
    });

    if (condition === 'stuck') heals.push({ agent: j.agent, jobId: j.id, action: 'clear_stale', reason: detail });
    if (condition === 'overdue') heals.push({ agent: j.agent, jobId: j.id, action: 'rearm', reason: detail });

    if (seenCount >= escalateAfter) {
      escalations.push({
        agent: j.agent, jobId: j.id, condition, key,
        action: prevOpen.has(key) ? 'update' : 'open',
        title: `[mesh-heartbeat] ${j.agent}/${j.id}: ${condition}`,
        body: `${detail}\n\n<!-- ${key} -->`,
      });
      nextOpen.add(key);
      summary.escalated++;
    }
  }

  // Close any issue whose condition is no longer present.
  for (const key of prevOpen) {
    if (!nextOpen.has(key)) escalations.push({ key, action: 'close', body: `Resolved by mesh-heartbeat.\n\n<!-- ${key} -->` });
  }

  return { findings, heals, escalations, openEscalations: [...nextOpen], summary };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/heartbeat-assess.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mesh-health/heartbeat.js test/heartbeat-assess.test.js
git commit -m "feat(mesh-health): pure assessMeshHealth — classify scheduled-job health

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Impure `runHeartbeat`

**Files:**
- Create: `src/mesh-health/heartbeat-runner.js`
- Test: `test/heartbeat-runner.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/heartbeat-runner.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runHeartbeat } from '../src/mesh-health/heartbeat-runner.js';

const NOW = new Date('2026-06-18T12:00:00Z');
const TH = { failThreshold: 3, overdueGraceMs: 900_000, staleMs: 1_800_000, escalateAfter: 2 };
const overdueJob = { agent: 'orchestrator', id: 'p', enabled: true, cadence: { kind: 'every', minutes: 5 }, running: false, lastStatus: 'ok', lastRunAt: '2026-06-18T11:00:00Z', nextRunAt: '2026-06-18T11:00:00Z', consecutiveFailures: 0 };

function harness({ prev = null, jobs = [overdueJob] } = {}) {
  const calls = { heals: [], issues: [], snapshots: [] };
  return {
    calls,
    deps: {
      meshRoot: '/mesh', now: NOW, thresholds: TH,
      listSchedules: async () => jobs,
      readSnapshot: async () => prev,
      writeSnapshot: async (s) => { calls.snapshots.push(s); },
      applyHeal: async (h) => { calls.heals.push(h); },
      openIssue: async (e) => { calls.issues.push(e); },
    },
  };
}

test('overdue → rearm heal applied + snapshot written; warn (no escalation) on first sight', async () => {
  const { calls, deps } = harness();
  const r = await runHeartbeat(deps);
  assert.equal(r.status, 'ok');
  assert.equal(calls.heals[0].action, 'rearm');
  assert.equal(calls.snapshots.length, 1);
  assert.equal(calls.snapshots[0].findings[0].condition, 'overdue');
  assert.equal(calls.issues.length, 0); // seenCount 1 < escalateAfter
});

test('snapshot is written BEFORE issues are opened (gh failure keeps the snapshot)', async () => {
  const prev = { findings: [{ agent: 'orchestrator', jobId: 'p', condition: 'overdue', seenCount: 1, since: NOW.toISOString() }], openEscalations: [] };
  const { calls, deps } = harness({ prev });
  let order = [];
  deps.writeSnapshot = async (s) => { order.push('snapshot'); calls.snapshots.push(s); };
  deps.openIssue = async () => { order.push('issue'); throw new Error('gh down'); };
  const r = await runHeartbeat(deps);
  assert.equal(r.status, 'fail');           // the throw is caught → fail
  assert.deepEqual(order, ['snapshot', 'issue']); // snapshot first
  assert.equal(calls.snapshots.length, 1);  // snapshot survived
});

test('recovery closes the issue', async () => {
  const prev = { findings: [], openEscalations: ['mesh-heartbeat:orchestrator/p/overdue'] };
  const healthy = { ...overdueJob, nextRunAt: '2026-06-18T12:04:00Z' };
  const { calls, deps } = harness({ prev, jobs: [healthy] });
  await runHeartbeat(deps);
  assert.equal(calls.issues[0].action, 'close');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/heartbeat-runner.test.js`
Expected: FAIL — `Cannot find module '../src/mesh-health/heartbeat-runner.js'`.

- [ ] **Step 3: Write `src/mesh-health/heartbeat-runner.js`**

```js
// Impure: gather the mesh-wide schedule list, assess (pure), apply the safe
// heals, write the snapshot the dashboard reads, then route escalations to a
// de-duped GitHub issue. Snapshot is written BEFORE issues so a gh failure
// still leaves the dashboard an accurate health view; issue routing is
// idempotent (dedup) and retries next tick.
import { assessMeshHealth } from './heartbeat.js';

/**
 * @param {object} deps  injected I/O (all async):
 *   listSchedules(meshRoot) → jobs[]   (listAllSchedules)
 *   readSnapshot()          → prev snapshot | null
 *   writeSnapshot(snap)     → void
 *   applyHeal({agent,jobId,action,cadence,now}) → void   (mutates schedule-state)
 *   openIssue({key,action,title?,body}) → void           (gh create/comment/close)
 * @returns {{status:'ok'|'fail', summary?, error?}}
 */
export async function runHeartbeat({ meshRoot, now = new Date(), thresholds, listSchedules, readSnapshot, writeSnapshot, applyHeal, openIssue }) {
  try {
    const prev = await readSnapshot().catch(() => null);
    const jobs = await listSchedules(meshRoot);
    const { findings, heals, escalations, openEscalations, summary } = assessMeshHealth({ jobs, now, thresholds, prev });

    const byKey = new Map(jobs.map((j) => [`${j.agent}/${j.id}`, j]));
    for (const h of heals) {
      const job = byKey.get(`${h.agent}/${h.jobId}`);
      await applyHeal({ ...h, cadence: job?.cadence, now });
    }

    await writeSnapshot({ generatedAt: now.toISOString(), summary, findings, openEscalations });

    for (const e of escalations) await openIssue(e);

    return { status: 'ok', summary };
  } catch (err) {
    return { status: 'fail', error: err?.message || String(err) };
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/heartbeat-runner.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mesh-health/heartbeat-runner.js test/heartbeat-runner.test.js
git commit -m "feat(mesh-health): runHeartbeat — gather/assess/heal/snapshot/escalate

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Config defaults + daemon heartbeat loop

**Files:**
- Modify: `src/config.js`
- Modify: `scripts/dev-society-daemon.mjs`
- Test: `test/heartbeat-daemon.test.js`

- [ ] **Step 1: Add heartbeat defaults to `src/config.js`**

After the existing `DEFAULT_*` exports, add:
```js
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 300_000;   // 5m mesh-health tick (0 disables)
export const DEFAULT_HEARTBEAT_FAIL_THRESHOLD = 3;      // consecutive fails → failing
export const DEFAULT_HEARTBEAT_OVERDUE_GRACE_MS = 900_000;  // 15m past nextRunAt → overdue
export const DEFAULT_HEARTBEAT_STALE_MS = 1_800_000;    // 30m running → stuck
export const DEFAULT_HEARTBEAT_ESCALATE_AFTER = 2;      // heartbeats a finding must persist before a GH issue
```

- [ ] **Step 2: Write the failing daemon-wiring lint**

```js
// test/heartbeat-daemon.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const daemon = readFileSync(fileURLToPath(new URL('../scripts/dev-society-daemon.mjs', import.meta.url)), 'utf8');

test('daemon wires the mesh-level heartbeat loop', () => {
  assert.match(daemon, /runHeartbeat/, 'imports/uses runHeartbeat');
  assert.match(daemon, /AGENT_MESH_HEARTBEAT_FILE|heartbeat\.json/, 'has a heartbeat snapshot path');
  assert.match(daemon, /HEARTBEAT_INTERVAL_MS|DEFAULT_HEARTBEAT_INTERVAL_MS/, 'uses the interval');
  assert.match(daemon, /setInterval\(\s*heartbeatTick|heartbeatTimer\s*=\s*setInterval/s, 'starts a heartbeat interval');
  assert.match(daemon, /clearInterval\(\s*heartbeatTimer\s*\)/, 'clears the heartbeat on shutdown');
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --test test/heartbeat-daemon.test.js`
Expected: FAIL — none of the heartbeat wiring exists yet.

- [ ] **Step 4: Wire the heartbeat into `scripts/dev-society-daemon.mjs`**

(a) Add imports near the existing `createScheduler` import (~line 38) and the `listAllSchedules`/cadence/config deps:
```js
import { runHeartbeat } from '../src/mesh-health/heartbeat-runner.js';
import { listAllSchedules } from '../src/schedule/list-all.js';
import { computeNextRun } from '../src/schedule/schedule-cadence.js';
import { DEFAULT_HEARTBEAT_INTERVAL_MS, DEFAULT_HEARTBEAT_FAIL_THRESHOLD, DEFAULT_HEARTBEAT_OVERDUE_GRACE_MS, DEFAULT_HEARTBEAT_STALE_MS, DEFAULT_HEARTBEAT_ESCALATE_AFTER } from '../src/config.js';
```
Also add `readFileSync` to the existing `node:fs` import line (it currently imports `{ mkdirSync, appendFileSync, rmSync, existsSync, realpathSync, writeFileSync }`):
```js
import { mkdirSync, appendFileSync, rmSync, existsSync, realpathSync, writeFileSync, readFileSync } from 'node:fs';
```
And `resolve`, `join`, `dirname` from `node:path` (it imports `{ dirname, join }` — add `resolve`):
```js
import { dirname, join, resolve } from 'node:path';
```

(b) Inside the SAME `if (!once && !selftest)` block where the scheduler is created (right after `sched.start()`, ~line 71), add the heartbeat wiring. `repoRoot`, `cfg`, `gh`, `SCHED_MESH_ROOT`, `log`, `mkdirSync`, `writeFileSync` are all in scope:
```js
  const heartbeatFile = process.env.AGENT_MESH_HEARTBEAT_FILE || join(repoRoot, '.dev-society', 'heartbeat.json');
  const HB_INTERVAL = Number(process.env.AGENT_MESH_HEARTBEAT_INTERVAL_MS) || DEFAULT_HEARTBEAT_INTERVAL_MS;
  const hbThresholds = {
    failThreshold: Number(process.env.AGENT_MESH_HEARTBEAT_FAIL_THRESHOLD) || DEFAULT_HEARTBEAT_FAIL_THRESHOLD,
    overdueGraceMs: Number(process.env.AGENT_MESH_HEARTBEAT_OVERDUE_GRACE_MS) || DEFAULT_HEARTBEAT_OVERDUE_GRACE_MS,
    staleMs: Number(process.env.AGENT_MESH_HEARTBEAT_STALE_MS) || DEFAULT_HEARTBEAT_STALE_MS,
    escalateAfter: Number(process.env.AGENT_MESH_HEARTBEAT_ESCALATE_AFTER) || DEFAULT_HEARTBEAT_ESCALATE_AFTER,
  };

  // Mutate one agent's schedule-state.json for a heal (idempotent).
  const applyHeal = async ({ agent, jobId, action, cadence, now }) => {
    const statePath = join(SCHED_MESH_ROOT, agent, '.agent-mesh', 'schedule-state.json');
    let state = {};
    try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch { return; }
    const entry = state[jobId]; if (!entry) return;
    if (action === 'clear_stale') entry.running = false;
    if (action === 'rearm' && cadence) { entry.nextRunAt = computeNextRun(cadence, now).toISOString(); entry.running = false; }
    state[jobId] = entry;
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
  };

  // Open / comment / close a de-duped mesh-heartbeat issue (marker in the body).
  const openIssue = async ({ key, action, title, body }) => {
    const found = await gh(['issue', 'list', '--repo', cfg.repo, '--state', 'open', '--search', `${key} in:body`, '--json', 'number', '--jq', '.[0].number'])
      .then((r) => r.stdout.trim()).catch(() => '');
    if (action === 'close') {
      if (found) await gh(['issue', 'close', found, '--repo', cfg.repo, '--comment', body]).catch((e) => log('  (hb close failed)', e.message));
      return;
    }
    if (found) { await gh(['issue', 'comment', found, '--repo', cfg.repo, '--body', body]).catch((e) => log('  (hb comment failed)', e.message)); return; }
    await gh(['issue', 'create', '--repo', cfg.repo, '--title', title, '--body', body, '--label', 'mesh-heartbeat']).catch((e) => log('  (hb create failed)', e.message));
  };

  const heartbeatTick = async () => {
    const r = await runHeartbeat({
      meshRoot: SCHED_MESH_ROOT, now: new Date(), thresholds: hbThresholds,
      listSchedules: (mr) => listAllSchedules({ meshRoot: mr }).then((x) => x.jobs),
      readSnapshot: async () => { try { return JSON.parse(readFileSync(heartbeatFile, 'utf8')); } catch { return null; } },
      writeSnapshot: async (snap) => { mkdirSync(dirname(heartbeatFile), { recursive: true }); writeFileSync(heartbeatFile, JSON.stringify(snap, null, 2)); },
      applyHeal, openIssue,
    });
    if (r.status === 'fail') log('heartbeat failed:', r.error);
    else if (r.summary && (r.summary.failing || r.summary.overdue || r.summary.stuck)) log('heartbeat:', JSON.stringify(r.summary));
  };

  let heartbeatTimer = null;
  if (HB_INTERVAL > 0) {
    heartbeatTimer = setInterval(heartbeatTick, HB_INTERVAL);
    log('heartbeat started — interval=' + HB_INTERVAL + 'ms');
  }
```

(c) In the shutdown handler (~line 75), also clear the heartbeat timer:
```js
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { try { sched?.stop(); } catch {} try { clearInterval(heartbeatTimer); } catch {} process.exit(0); });
```
NOTE: `heartbeatTimer` is declared inside the `if (!once && !selftest)` block but referenced in the shutdown handler. VERIFY the real scoping — if the shutdown handler can't see it, hoist a `let heartbeatTimer = null;` to the same top-level scope as `let sched = null;` (~line 60) and assign inside the block (mirror exactly how `sched` is handled). Match the file's existing pattern.

- [ ] **Step 5: Run the lint + the selftest (no scheduler/heartbeat start, no network)**

Run: `node --test test/heartbeat-daemon.test.js` → PASS.
Run: `DEV_SOCIETY_REPO=x node scripts/dev-society-daemon.mjs --selftest` → exits 0, `selftest OK`, no heartbeat/scheduler start (it's behind the guard).

- [ ] **Step 6: Commit**

```bash
git add src/config.js scripts/dev-society-daemon.mjs test/heartbeat-daemon.test.js
git commit -m "feat(dev-society): mesh-level heartbeat loop (heal + de-duped gh escalation)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Dashboard `GET /api/health`

**Files:**
- Modify: `src/dashboard/server.js`
- Test: `test/health-route.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/health-route.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDashboardServer } from '../src/dashboard/server.js';
import { initMesh } from '../src/builder/init-mesh.js';

async function boot(meshRoot) {
  const srv = createDashboardServer({ meshRoot, port: 0 });
  await srv.start();
  const port = new URL(srv.url).port;
  const r = await fetch(`${srv.url}/?t=${srv.token}`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'none' }, redirect: 'manual' });
  const cookie = `am_dash=${r.headers.get('set-cookie').match(/am_dash=([^;]+)/)[1]}`;
  return { srv, port, cookie };
}

test('GET /api/health returns the heartbeat snapshot', async () => {
  const meshRoot = await mkdtemp(join(tmpdir(), 'hb-route-'));
  await initMesh(meshRoot);
  const cacheDir = resolve(meshRoot, '..', '.dev-society');
  await mkdir(cacheDir, { recursive: true });
  await writeFile(join(cacheDir, 'heartbeat.json'), JSON.stringify({
    generatedAt: '2026-06-18T12:00:00Z',
    summary: { ok: 2, failing: 1, overdue: 0, stuck: 0, escalated: 1 },
    findings: [{ agent: 'coder', jobId: 'autofix', condition: 'failing', severity: 'error', detail: '3 consecutive failures', since: '2026-06-18T11:50:00Z', seenCount: 2 }],
    openEscalations: ['mesh-heartbeat:coder/autofix/failing'],
  }), 'utf8');

  const { srv, port, cookie } = await boot(meshRoot);
  try {
    const r = await fetch(`${srv.url}/api/health`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.summary.failing, 1);
    assert.equal(body.findings[0].agent, 'coder');
  } finally { await srv.close(); }
});

test('GET /api/health degrades to empty health when no snapshot (never 500)', async () => {
  const meshRoot = await mkdtemp(join(tmpdir(), 'hb-route-empty-'));
  await initMesh(meshRoot);
  const { srv, port, cookie } = await boot(meshRoot);
  try {
    const r = await fetch(`${srv.url}/api/health`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.deepEqual(body.findings, []);
  } finally { await srv.close(); }
});
```

VERIFY the boot/auth helper against the real harness — copy it verbatim from `test/activity-gh-merge.test.js` (Phase 2) if that file's bootstrap differs (Host header, Sec-Fetch-Site, cookie extraction).

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/health-route.test.js`
Expected: FAIL — `/api/health` 404s (route not added).

- [ ] **Step 3: Add the route in `src/dashboard/server.js`**

Find where the existing read-only routes are registered (search for `'/api/schedules'` — the Phase-1 route added in `handleRequest`). Add an `/api/health` handler beside it, following that route's exact auth/`sendJson` pattern:
```js
    if (pathname === '/api/health') {
      const file = process.env.AGENT_MESH_HEARTBEAT_FILE || resolve(meshRoot, '..', '.dev-society', 'heartbeat.json');
      let snap = { generatedAt: null, summary: { ok: 0, failing: 0, overdue: 0, stuck: 0, escalated: 0 }, findings: [], openEscalations: [] };
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8'));
        if (parsed && typeof parsed === 'object') snap = parsed;
      } catch { /* missing/corrupt snapshot → empty health */ }
      sendJson(res, 200, snap);
      return;
    }
```
(`readFile` from `node:fs/promises`, `resolve` from `node:path`, and `sendJson` are already imported/used by the sibling routes — confirm and reuse; do not duplicate imports. Match the exact route-dispatch shape of `/api/schedules`, including how `pathname`, `res`, and auth are handled in that function.)

- [ ] **Step 4: Run to verify it passes + no regression**

Run: `node --test test/health-route.test.js` → PASS (2 tests).
Run: `node --test test/activity-gh-merge.test.js test/schedules-route.test.js` → PASS (sibling routes unaffected; use the real schedules-route test filename if different).

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/server.js test/health-route.test.js
git commit -m "feat(dashboard): GET /api/health — read-only heartbeat snapshot

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Dashboard Health panel (Graph view)

**Files:**
- Modify: `src/dashboard/public/graph-view.js`
- Modify: `src/dashboard/public/board2.css` (only if a new pill class is needed)

This task is **UI**; verification is visual (Task 7 drives the browser), not a unit test. Keep it additive and match the existing foldable-panel pattern.

- [ ] **Step 1: Read the existing patterns FIRST**

Read `src/dashboard/public/graph-view.js` and find how an existing foldable section (e.g. the Tokens or Issues/Schedules section) is built: its fetch (`fetch('/api/...')`), its fold/maximize controls, and the board2.css classes it uses. The Health panel must mirror that pattern exactly (same fold/`⤢` maximize affordances, same paper theme). Note the function that polls/renders sections and the SSE/refresh cadence.

- [ ] **Step 2: Add a `renderHealth` section**

Add a foldable "Health" section that fetches `/api/health` on the same cadence as the other panels and renders:
- A header pill: green "all healthy" when `summary.failing+overdue+stuck === 0`, else a count badge (e.g. "2 issues") colored by worst severity.
- A list grouped by severity (error first), each row: `agent · jobId · condition · since (relative) · detail`, and when the finding's key is in `openEscalations`, a link to the GitHub issue search (`https://github.com/<repo>/issues?q=is:issue+is:open+label:mesh-heartbeat`).
- Empty/healthy state: a calm "All scheduled jobs healthy" line.

Concrete skeleton (adapt names/DOM helpers to match the file's existing style — if the file uses a `el(tag, props, children)` helper or template strings, use that; do NOT introduce a new rendering style):
```js
async function renderHealth(container) {
  let data;
  try { data = await (await fetch('/api/health', { credentials: 'same-origin' })).json(); }
  catch { container.textContent = 'health unavailable'; return; }
  const { summary = {}, findings = [], openEscalations = [] } = data;
  const bad = (summary.failing || 0) + (summary.overdue || 0) + (summary.stuck || 0);
  const head = bad === 0 ? 'All scheduled jobs healthy' : `${bad} issue${bad === 1 ? '' : 's'}`;
  // … build the foldable section header with `head` + a severity-colored pill …
  if (findings.length === 0) { /* render the calm healthy line */ return; }
  const order = { error: 0, warn: 1 };
  for (const f of [...findings].sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9))) {
    const escalated = openEscalations.includes(`mesh-heartbeat:${f.agent}/${f.jobId}/${f.condition}`);
    // … render a row: agent · jobId · condition · relativeTime(f.since) · f.detail (+ issue link if escalated) …
  }
}
```
Wire `renderHealth` into the view's section list/refresh exactly like the sibling panels (Tokens/Schedules), so it folds, maximizes, and refreshes consistently.

- [ ] **Step 3: Manual smoke (local)**

Run the dashboard locally against a planted snapshot and confirm the panel renders both states:
```bash
# from the worktree root
mkdir -p .dev-society
printf '%s' '{"generatedAt":"2026-06-18T12:00:00Z","summary":{"ok":2,"failing":1,"overdue":1,"stuck":0,"escalated":1},"findings":[{"agent":"coder","jobId":"autofix","condition":"failing","severity":"error","detail":"3 consecutive failures","since":"2026-06-18T11:50:00Z","seenCount":2},{"agent":"analyst","jobId":"research","condition":"overdue","severity":"warn","detail":"nextRunAt overdue","since":"2026-06-18T11:58:00Z","seenCount":1}],"openEscalations":["mesh-heartbeat:coder/autofix/failing"]}' > .dev-society/heartbeat.json
node ./bin/agent-mesh.js dashboard dev-mesh   # or the real dashboard launch verb — check bin/--help
# open the printed URL, expand the Health panel, confirm the error row + escalation link, then delete the snapshot and confirm the healthy state
rm .dev-society/heartbeat.json
```
(If unsure of the dashboard launch verb, check `node ./bin/agent-mesh.js --help`. This step is the verification handoff for Task 7's visual check, not an automated test.)

- [ ] **Step 4: Commit**

```bash
git add src/dashboard/public/graph-view.js src/dashboard/public/board2.css
git commit -m "feat(dashboard): Health panel — mesh-heartbeat findings + escalation links

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Full-suite verification + live check

- [ ] **Step 1: Run the whole suite**

Run: `npm test`
Expected: PASS — all existing + new (`scheduler-failcount` 1, `heartbeat-assess` 7, `heartbeat-runner` 3, `heartbeat-daemon` 1, `health-route` 2); 0 failures. (The pre-existing skip count is unchanged.)

- [ ] **Step 2: Live-ish heartbeat smoke (no network needed)**

Run a single heartbeat tick against the real dev-mesh with stubbed `gh`/snapshot, proving the end-to-end runner path writes a snapshot:
```bash
node -e "
import('./src/mesh-health/heartbeat-runner.js').then(async m=>{
  const { listAllSchedules } = await import('./src/schedule/list-all.js');
  const fs=await import('node:fs');
  const r=await m.runHeartbeat({
    meshRoot:'dev-mesh', now:new Date(), thresholds:{ failThreshold:3, overdueGraceMs:900000, staleMs:1800000, escalateAfter:2 },
    listSchedules:(mr)=>listAllSchedules({meshRoot:mr}).then(x=>x.jobs),
    readSnapshot:async()=>null,
    writeSnapshot:async(s)=>fs.writeFileSync('/tmp/hb-smoke.json', JSON.stringify(s,null,2)),
    applyHeal:async(h)=>console.log('HEAL', h.action, h.agent+'/'+h.jobId),
    openIssue:async(e)=>console.log('ISSUE', e.action, e.key),
  });
  console.log('RESULT', JSON.stringify(r));
});
"
cat /tmp/hb-smoke.json
```
Expected: `RESULT {"status":"ok",...}` and a written snapshot with a `summary` + `findings` array (likely all-healthy → empty findings, which is the correct steady state).

- [ ] **Step 3: Visual check (dashboard Health panel)**

Use the `superpowers:verify` skill (drive the real browser) against a planted `/tmp`/`.dev-society/heartbeat.json` (see Task 6 Step 3) to confirm the Health panel renders the error row + escalation link and the healthy empty-state. Capture a screenshot as evidence.

- [ ] **Step 4: Commit (empty if clean)**

```bash
git commit --allow-empty -m "test(heartbeat): Phase 3 verified — npm test green + heartbeat snapshot smoke

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-review notes (author)

- **Spec component 1 (heartbeat loop, mesh-level, in daemon)** → Task 4. ✓
- **Component 2 (pure assessMeshHealth: classify/heal/escalate, seenCount, precedence)** → Task 2 (every condition + the open/update/close transition tested). ✓
- **Component 3 (runHeartbeat orchestration, snapshot-before-issues ordering)** → Task 3. ✓
- **Component: consecutiveFailures counter (needed for builtin jobs)** → Task 1. ✓
- **Component 4 (/api/health read-only, tolerant)** → Task 5. ✓
- **Component 5 (Health panel)** → Task 6. ✓
- **Config knobs** → Task 4 Step 1. ✓
- **De-dup contract (one open issue per key; auto-close on recovery)** → Task 2 (assess open/update/close) + Task 4 (`openIssue` gh search-by-marker). ✓
- **Error handling / tolerance (never crash, degrade to empty)** → Task 3 (try/catch), Task 5 (empty health), Task 4 (`applyHeal`/`openIssue` swallow). ✓
- **Invariant: heals are idempotent state writes only; no retry/disable/restart** → Task 2 emits only `clear_stale`/`rearm`; Task 4 `applyHeal` does only those. ✓
- **Naming consistency:** `assessMeshHealth`, `runHeartbeat`, `consecutiveFailures`, `openEscalations`, `seenCount`, `applyHeal`, `openIssue`, `heartbeatFile`/`AGENT_MESH_HEARTBEAT_FILE`, `mesh-heartbeat:<agent>/<jobId>/<condition>` — identical across tasks.
- **Deferred:** aggressive remediation + non-scheduled health (ping/conformance) — per spec.
