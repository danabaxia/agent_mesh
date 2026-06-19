# Mesh Unified Activity Log — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One durable, normalized, local activity event log (`.dev-society/activity-YYYY-MM-DD.jsonl`) that the daemon's loops append to, surfaced by a foldable, filterable dashboard panel.

**Architecture:** A pure `event.js` (format + filter) + an injectable `log.js` (record/read/prune) in `src/activity-log/`; fail-safe `recordActivity` emit calls at ~5 daemon points (issue loop, scheduler `onJobResult` hook, heartbeat, gh-activity poll) + a daily prune; a read-only `/api/activity-log` route + a Graph-view panel. Mirrors the Phase-2/3 pure/impure/route/panel patterns.

**Tech Stack:** Node ≥20, ESM, zero deps, `node --test`.

Spec: `docs/superpowers/specs/2026-06-19-mesh-activity-log-design.md`.

---

## File structure

| File | Responsibility |
|---|---|
| `src/config.js` (modify) | `DEFAULT_ACTIVITY_KEEP_DAYS`, `MAX_ACTIVITY_SUMMARY` |
| `src/activity-log/event.js` (new) | pure `formatEvent` + `filterEvents` |
| `src/activity-log/log.js` (new) | impure `recordActivity` / `readActivity` / `pruneActivity` |
| `src/schedule/scheduler.js` (modify) | optional `onJobResult` hook (fires per scheduled job run) |
| `scripts/dev-society-daemon.mjs` (modify) | emit calls (issue loop, scheduler hook, heartbeat, gh-activity) + prune |
| `src/dashboard/server.js` (modify) | `GET /api/activity-log` (read-only, filterable) |
| `src/dashboard/public/graph-view.js` + `graph-view.css` (modify) | foldable "Activity Log" panel |
| `test/activity-event.test.js`, `test/activity-log.test.js`, `test/scheduler-onjobresult.test.js`, `test/activity-log-route.test.js`, `test/activity-log-daemon.test.js` (new) | coverage |

---

## Task 1: Config consts + pure `event.js`

**Files:**
- Modify: `src/config.js`
- Create: `src/activity-log/event.js`
- Test: `test/activity-event.test.js`

- [ ] **Step 1: Add config consts**

In `src/config.js`, after the `DEFAULT_HEARTBEAT_*` block, add:
```js
export const DEFAULT_ACTIVITY_KEEP_DAYS = 30;   // prune activity-*.jsonl older than this
export const MAX_ACTIVITY_SUMMARY = 240;        // activity event summary char cap
```

- [ ] **Step 2: Write the failing test `test/activity-event.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatEvent, filterEvents } from '../src/activity-log/event.js';

const NOW = new Date('2026-06-19T12:00:00Z');
const now = () => NOW;

test('formatEvent: normalizes, stamps ts, defaults level, drops empty optionals', () => {
  const e = formatEvent({ source: 'daemon', type: 'issue.picked', summary: 'took #98' }, { now });
  assert.equal(e.ts, '2026-06-19T12:00:00.000Z');
  assert.equal(e.source, 'daemon');
  assert.equal(e.type, 'issue.picked');
  assert.equal(e.level, 'info');
  assert.equal(e.summary, 'took #98');
  assert.equal('agent' in e, false);
  assert.equal('ref' in e, false);
  assert.equal('detail' in e, false);
});

test('formatEvent: keeps agent/ref/detail, validates level, caps summary', () => {
  const e = formatEvent({ source: 'gh-activity', agent: 'coder', type: 'ci.run', level: 'warn', summary: 'x'.repeat(500), ref: 'run#5', detail: { status: 'success' } }, { now });
  assert.equal(e.agent, 'coder');
  assert.equal(e.level, 'warn');
  assert.equal(e.summary.length, 240);
  assert.equal(e.ref, 'run#5');
  assert.deepEqual(e.detail, { status: 'success' });
});

test('formatEvent: bad level → info; missing fields → safe defaults', () => {
  const e = formatEvent({ level: 'screaming' }, { now });
  assert.equal(e.level, 'info');
  assert.equal(e.source, 'daemon');
  assert.equal(e.type, 'event');
  assert.equal(e.summary, '');
});

test('filterEvents: by agent/type/level/since, combined', () => {
  const evs = [
    { ts: '2026-06-19T10:00:00Z', agent: 'coder', type: 'delegate.done', level: 'info' },
    { ts: '2026-06-19T11:00:00Z', agent: 'reviewer', type: 'delegate.done', level: 'info' },
    { ts: '2026-06-18T09:00:00Z', agent: 'coder', type: 'task.error', level: 'error' },
  ];
  assert.equal(filterEvents(evs, { agent: 'coder' }).length, 2);
  assert.equal(filterEvents(evs, { type: 'delegate.done' }).length, 2);
  assert.equal(filterEvents(evs, { level: 'error' }).length, 1);
  assert.equal(filterEvents(evs, { since: '2026-06-19T00:00:00Z' }).length, 2);
  assert.equal(filterEvents(evs, { agent: 'coder', since: '2026-06-19T00:00:00Z' }).length, 1);
  assert.equal(filterEvents(evs, {}).length, 3);
  assert.deepEqual(filterEvents(null, {}), []);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --test test/activity-event.test.js`
Expected: FAIL — `Cannot find module '../src/activity-log/event.js'`.

- [ ] **Step 4: Write `src/activity-log/event.js`**

```js
// Pure: normalize an activity event into the canonical shape, and filter a list.
// No I/O. The single place the event shape + filter semantics are defined.
import { MAX_ACTIVITY_SUMMARY } from '../config.js';

const LEVELS = new Set(['info', 'warn', 'error']);

/**
 * @returns {{ts, source, type, level, summary, agent?, ref?, detail?}}
 */
export function formatEvent({ source, agent, type, level, summary, ref, detail } = {}, { now = () => new Date() } = {}) {
  const ev = {
    ts: now().toISOString(),
    source: String(source || 'daemon'),
    type: String(type || 'event'),
    level: LEVELS.has(level) ? level : 'info',
    summary: String(summary == null ? '' : summary).slice(0, MAX_ACTIVITY_SUMMARY),
  };
  if (agent) ev.agent = String(agent);
  if (ref) ev.ref = String(ref);
  if (detail && typeof detail === 'object') ev.detail = detail;
  return ev;
}

export function filterEvents(events, { agent, type, since, level } = {}) {
  const sinceMs = since ? Date.parse(since) : NaN;
  return (Array.isArray(events) ? events : []).filter((e) => {
    if (!e || typeof e !== 'object') return false;
    if (agent && e.agent !== agent) return false;
    if (type && e.type !== type) return false;
    if (level && e.level !== level) return false;
    if (Number.isFinite(sinceMs) && Date.parse(e.ts) < sinceMs) return false;
    return true;
  });
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `node --test test/activity-event.test.js`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/config.js src/activity-log/event.js test/activity-event.test.js
git commit -m "feat(activity-log): pure formatEvent + filterEvents + config consts

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Impure `log.js` (record / read / prune)

**Files:**
- Create: `src/activity-log/log.js`
- Test: `test/activity-log.test.js`

- [ ] **Step 1: Write the failing test `test/activity-log.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordActivity, readActivity, pruneActivity } from '../src/activity-log/log.js';

const tmp = () => mkdtemp(join(tmpdir(), 'activity-'));

test('recordActivity appends a parseable line to the dated file', async () => {
  const dir = await tmp();
  const now = () => new Date('2026-06-19T12:00:00Z');
  recordActivity({ source: 'daemon', type: 'issue.picked', summary: 'took #98', ref: '#98' }, { dir, now });
  const txt = await readFile(join(dir, 'activity-2026-06-19.jsonl'), 'utf8');
  const ev = JSON.parse(txt.trim());
  assert.equal(ev.type, 'issue.picked');
  assert.equal(ev.ref, '#98');
  assert.equal(ev.ts, '2026-06-19T12:00:00.000Z');
});

test('recordActivity is fail-safe (un-writable dir → no throw)', () => {
  assert.doesNotThrow(() => recordActivity({ summary: 'x' }, { dir: '/proc/nonexistent/nope', now: () => new Date('2026-06-19T00:00:00Z') }));
});

test('readActivity reads recent files newest-first, since-windowed, capped, skips malformed', async () => {
  const dir = await tmp();
  await writeFile(join(dir, 'activity-2026-06-18.jsonl'), JSON.stringify({ ts: '2026-06-18T10:00:00Z', type: 'a' }) + '\nGARBAGE\n', 'utf8');
  await writeFile(join(dir, 'activity-2026-06-19.jsonl'), JSON.stringify({ ts: '2026-06-19T10:00:00Z', type: 'b' }) + '\n' + JSON.stringify({ ts: '2026-06-19T11:00:00Z', type: 'c' }) + '\n', 'utf8');
  const all = readActivity({ dir });
  assert.deepEqual(all.map((e) => e.type), ['c', 'b', 'a']);     // newest first, malformed skipped
  const recent = readActivity({ dir, since: '2026-06-19T00:00:00Z' });
  assert.deepEqual(recent.map((e) => e.type), ['c', 'b']);        // since-windowed
  assert.equal(readActivity({ dir, limit: 1 }).length, 1);        // capped
  assert.deepEqual(readActivity({ dir: join(dir, 'missing') }), []); // tolerant
});

test('pruneActivity removes only files older than keepDays', async () => {
  const dir = await tmp();
  for (const d of ['2026-05-01', '2026-06-18', '2026-06-19']) await writeFile(join(dir, `activity-${d}.jsonl`), '{}\n', 'utf8');
  const now = () => new Date('2026-06-19T12:00:00Z');
  const { removed } = pruneActivity({ dir, keepDays: 30, now });
  assert.deepEqual(removed, ['activity-2026-05-01.jsonl']);       // >30 days
  const left = (await readdir(dir)).sort();
  assert.deepEqual(left, ['activity-2026-06-18.jsonl', 'activity-2026-06-19.jsonl']);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/activity-log.test.js`
Expected: FAIL — `Cannot find module '../src/activity-log/log.js'`.

- [ ] **Step 3: Write `src/activity-log/log.js`**

```js
// Impure: append/read/prune the daily activity JSONL files. recordActivity is
// FAIL-SAFE — it must never throw into a daemon loop. read/prune are tolerant.
import { mkdirSync, appendFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { formatEvent, filterEvents } from './event.js';

const dateOf = (d) => d.toISOString().slice(0, 10);                 // YYYY-MM-DD
const DATE_RE = /^activity-(\d{4}-\d{2}-\d{2})\.jsonl$/;

export function recordActivity(input, { dir, now = () => new Date() } = {}) {
  try {
    const ev = formatEvent(input, { now });
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `activity-${dateOf(now())}.jsonl`), JSON.stringify(ev) + '\n');
  } catch { /* logging must never break the caller */ }
}

/**
 * Recent events, newest-first, since-windowed, capped. (agent/type/level filtering
 * is applied by callers via filterEvents — this does file scan + since + sort + cap.)
 */
export function readActivity({ dir, since, limit = 200, maxFiles = 14 } = {}) {
  let names;
  try { names = readdirSync(dir).filter((f) => DATE_RE.test(f)); } catch { return []; }
  names.sort().reverse();                                            // newest date first
  const sinceDate = since ? String(since).slice(0, 10) : null;
  const picked = sinceDate ? names.filter((f) => f.match(DATE_RE)[1] >= sinceDate) : names.slice(0, maxFiles);
  const out = [];
  for (const f of picked) {
    let lines;
    try { lines = readFileSync(join(dir, f), 'utf8').split('\n'); } catch { continue; }
    for (const line of lines) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }
  }
  out.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));  // newest first
  const windowed = since ? filterEvents(out, { since }) : out;
  return windowed.slice(0, limit);
}

export function pruneActivity({ dir, keepDays = 30, now = () => new Date() } = {}) {
  const removed = [];
  let names;
  try { names = readdirSync(dir).filter((f) => DATE_RE.test(f)); } catch { return { removed }; }
  const cutoffDate = dateOf(new Date(now().getTime() - keepDays * 86_400_000));
  for (const f of names) {
    if (f.match(DATE_RE)[1] < cutoffDate) {
      try { rmSync(join(dir, f)); removed.push(f); } catch { /* ignore */ }
    }
  }
  return { removed };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/activity-log.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/activity-log/log.js test/activity-log.test.js
git commit -m "feat(activity-log): recordActivity (fail-safe) + readActivity + pruneActivity

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Scheduler `onJobResult` hook

**Files:**
- Modify: `src/schedule/scheduler.js`
- Test: `test/scheduler-onjobresult.test.js`

- [ ] **Step 1: Write the failing test `test/scheduler-onjobresult.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScheduler } from '../src/schedule/scheduler.js';
import { initMesh } from '../src/builder/init-mesh.js';
import { writeManifest } from '../src/builder/manifest.js';

async function meshDueJob() {
  const root = await mkdtemp(join(tmpdir(), 'sched-hook-'));
  await initMesh(root);
  const a = join(root, 'orchestrator');
  await mkdir(join(a, '.agent'), { recursive: true });
  await writeFile(join(a, '.agent', 'schedule.json'), JSON.stringify({ jobs: [{ id: 'p', name: 'poll', kind: 'builtin', builtin: 'probe', cadence: { kind: 'every', minutes: 5 }, enabled: true }] }), 'utf8');
  await writeManifest(root, { meshVersion: '0.1.0', agents: [{ name: 'orchestrator', root: './orchestrator', card: 'agent.json', served: true, enabledModes: ['ask'], peers: [] }] });
  await mkdir(join(a, '.agent-mesh'), { recursive: true });
  await writeFile(join(a, '.agent-mesh', 'schedule-state.json'), JSON.stringify({ p: { nextRunAt: '2000-01-01T00:00:00Z' } }), 'utf8');
  return root;
}

test('onJobResult fires once per scheduled job run with agent/job/status/summary', async () => {
  const root = await meshDueJob();
  const seen = [];
  const sched = createScheduler({
    meshRoot: root,
    builtins: { probe: async () => ({ status: 'ok', output: 'done' }) },
    onJobResult: (info) => seen.push(info),
    now: () => new Date('2026-06-19T00:00:00Z'),
  });
  await sched.tick();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].agentName, 'orchestrator');
  assert.equal(seen[0].jobId, 'p');
  assert.equal(seen[0].status, 'ok');
});

test('a throwing onJobResult does not break the tick', async () => {
  const root = await meshDueJob();
  const sched = createScheduler({
    meshRoot: root,
    builtins: { probe: async () => ({ status: 'ok' }) },
    onJobResult: () => { throw new Error('boom'); },
    now: () => new Date('2026-06-19T00:00:00Z'),
  });
  await assert.doesNotReject(sched.tick());
});
```

VERIFY against `test/scheduler-builtin.test.js` for the exact harness (initMesh/writeManifest/injected `now`). Preserve the two behaviors.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/scheduler-onjobresult.test.js`
Expected: FAIL — `onJobResult` not invoked.

- [ ] **Step 3: Add the `onJobResult` hook to `src/schedule/scheduler.js`**

Add `onJobResult` to the `createScheduler` destructure:
```js
export function createScheduler({ meshRoot, runJob, builtins = {}, onJobResult, intervalMs = DEFAULT_INTERVAL_MS, now = () => new Date() }) {
```
In `executeJob`, AFTER the post-run state is derived (where `ok` and `lastSummary` exist — the object that writes `lastStatus: ok ? 'ok' : 'fail'`, ~line 210-218), add a fail-safe hook call (use the REAL local var names you find for the status/summary):
```js
      if (typeof onJobResult === 'function') {
        try { onJobResult({ agentName: agent.name, jobId: job.id, job, status: ok ? 'ok' : 'fail', summary: lastSummary }); } catch { /* a logging hook must never break the tick */ }
      }
```
Place it after `lastSummary`/`ok` are computed and the state is written, still inside the per-job try (or just after it) — but it MUST run for both ok and fail outcomes and MUST NOT throw into the tick. If `lastSummary` isn't the real var, use the summary value the state write uses.

- [ ] **Step 4: Run new test → PASS, then regression**

Run: `node --test test/scheduler-onjobresult.test.js` → PASS (2 tests).
Run: `node --test test/scheduler.test.js test/scheduler-builtin.test.js test/scheduler-failcount.test.js` → PASS (hook is additive; absent `onJobResult` → no-op).

- [ ] **Step 5: Commit**

```bash
git add src/schedule/scheduler.js test/scheduler-onjobresult.test.js
git commit -m "feat(schedule): optional onJobResult hook (fires per scheduled job run)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Daemon emit wiring + prune

**Files:**
- Modify: `scripts/dev-society-daemon.mjs`
- Test: `test/activity-log-daemon.test.js`

- [ ] **Step 1: Write the failing daemon-wiring lint `test/activity-log-daemon.test.js`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const daemon = readFileSync(fileURLToPath(new URL('../scripts/dev-society-daemon.mjs', import.meta.url)), 'utf8');

test('daemon wires the activity log', () => {
  assert.match(daemon, /recordActivity/, 'imports/uses recordActivity');
  assert.match(daemon, /pruneActivity/, 'wires the prune');
  assert.match(daemon, /onJobResult/, 'passes onJobResult to the scheduler');
  assert.match(daemon, /AGENT_MESH_ACTIVITY_DIR|activity-log/, 'has an activity dir');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/activity-log-daemon.test.js`
Expected: FAIL — no activity wiring yet.

- [ ] **Step 3: Wire the daemon (`scripts/dev-society-daemon.mjs`)**

(a) Imports (near the other `src/` imports):
```js
import { recordActivity, pruneActivity } from '../src/activity-log/log.js';
import { DEFAULT_ACTIVITY_KEEP_DAYS } from '../src/config.js';
```
(b) Near the other path consts (where `ghActivityPath`/`heartbeatFile` are defined, inside the `!once && !selftest` block):
```js
  const activityDir = process.env.AGENT_MESH_ACTIVITY_DIR || join(repoRoot, '.dev-society');
  const activityKeepDays = Number(process.env.AGENT_MESH_ACTIVITY_KEEP_DAYS) || DEFAULT_ACTIVITY_KEEP_DAYS;
  const rec = (ev) => recordActivity(ev, { dir: activityDir });            // fail-safe shorthand
  pruneActivity({ dir: activityDir, keepDays: activityKeepDays });          // prune on startup
```
(c) **Scheduler hook** — pass `onJobResult` when creating the scheduler (the `createScheduler({ meshRoot: SCHED_MESH_ROOT, builtins })` call):
```js
  sched = createScheduler({
    meshRoot: SCHED_MESH_ROOT, builtins,
    onJobResult: ({ agentName, jobId, status, summary }) =>
      rec({ source: 'scheduler', agent: agentName, type: 'job.run', level: status === 'ok' ? 'info' : 'warn', summary: `${jobId}: ${status}${summary ? ' — ' + summary : ''}`, ref: jobId }),
  });
```
(d) **Heartbeat** — in `heartbeatTick`, after `runHeartbeat` returns `r`, emit (fail-safe; only when there's something):
```js
    if (r && r.summary && (r.summary.failing || r.summary.overdue || r.summary.stuck || r.summary.escalated)) {
      rec({ source: 'heartbeat', type: 'heartbeat.summary', level: r.summary.escalated ? 'error' : 'warn', summary: `health: ${JSON.stringify(r.summary)}` });
    }
```
(e) **gh-activity poll** — in the `gh-activity-poll` builtin's `writeCache` closure, also emit one event per NEWLY-seen run (node records only, deduped by run id in an in-memory Set declared alongside `activityDir`):
```js
  const seenRuns = new Set();
  // … inside the builtins object, replace the gh-activity-poll writeCache with: …
      writeCache: (records) => {
        mkdirSync(dirname(ghActivityPath), { recursive: true });
        writeFileSync(ghActivityPath, JSON.stringify(records));
        for (const r of records) {
          if (typeof r.id !== 'string' || r.id.endsWith(':e')) continue;   // node records only (skip a2a edges)
          if (seenRuns.has(r.id)) continue;
          seenRuns.add(r.id);
          rec({ source: 'gh-activity', agent: r.agent, type: 'ci.run', summary: `${r.route || 'ci'}${r.finished_at ? ' (done)' : ' (running)'}`, ref: r.id });
        }
      },
```
(f) **Issue loop** — in `runOneTask`, add fail-safe `rec(...)` at the key points (adapt to the real var names you find — `issue.number`, the coder/reviewer task results, `prNumber`):
```js
  rec({ source: 'daemon', type: 'issue.picked', summary: `picked #${issue.number}: ${String(issue.title || '').slice(0, 80)}`, ref: `#${issue.number}` });
  // … after the coder runs (status known): …
  rec({ source: 'daemon', agent: 'coder', type: 'delegate.done', level: <coderStatus> === 'done' ? 'info' : 'warn', summary: `coder #${issue.number} → ${<coderStatus>}`, ref: `#${issue.number}` });
  // … after the PR is opened (prNumber captured): …
  if (prNumber) rec({ source: 'daemon', type: 'pr.opened', summary: `opened PR #${prNumber} for #${issue.number}`, ref: `pr#${prNumber}` });
  // … in the catch / failure path: …
  rec({ source: 'daemon', type: 'task.error', level: 'error', summary: `#${issue.number} failed: ${String(err && err.message || err).slice(0, 120)}`, ref: `#${issue.number}` });
```
Use the REAL variable names present in `runOneTask` (read it first). Each `rec(...)` is fail-safe; keep them minimal and at the genuine event points. Do NOT change the issue-processing logic — only add emit calls.

- [ ] **Step 4: Run the lint + selftest (no emit under selftest)**

Run: `node --test test/activity-log-daemon.test.js` → PASS.
Run: `DEV_SOCIETY_REPO=x node scripts/dev-society-daemon.mjs --selftest` → exits 0, `selftest OK`, and writes NO `activity-*.jsonl` (the emit/prune live inside the `!once && !selftest` block). Confirm: `ls .dev-society/activity-*.jsonl 2>/dev/null && echo "LEAKED" || echo "no activity files (correct)"`.

- [ ] **Step 5: Commit**

```bash
git add scripts/dev-society-daemon.mjs test/activity-log-daemon.test.js
git commit -m "feat(dev-society): emit activity events (issue/scheduler/heartbeat/gh) + daily prune

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Dashboard `GET /api/activity-log`

**Files:**
- Modify: `src/dashboard/server.js`
- Test: `test/activity-log-route.test.js`

- [ ] **Step 1: Write the failing test `test/activity-log-route.test.js`**

```js
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

test('GET /api/activity-log returns events + distinct agents/types, filters by query', async () => {
  const meshRoot = await mkdtemp(join(tmpdir(), 'al-route-'));
  await initMesh(meshRoot);
  const dir = resolve(meshRoot, '..', '.dev-society');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'activity-2026-06-19.jsonl'),
    JSON.stringify({ ts: '2026-06-19T10:00:00Z', source: 'daemon', agent: 'coder', type: 'delegate.done', summary: 'a' }) + '\n' +
    JSON.stringify({ ts: '2026-06-19T11:00:00Z', source: 'scheduler', agent: 'orchestrator', type: 'job.run', summary: 'b' }) + '\n', 'utf8');

  const { srv, port, cookie } = await boot(meshRoot);
  const get = (qs) => fetch(`${srv.url}/api/activity-log${qs}`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie } }).then((r) => r.json());
  try {
    const all = await get('');
    assert.equal(all.events.length, 2);
    assert.equal(all.events[0].summary, 'b');                 // newest first
    assert.deepEqual(all.agents.sort(), ['coder', 'orchestrator']);
    assert.ok(all.types.includes('job.run'));
    const filtered = await get('?agent=coder');
    assert.equal(filtered.events.length, 1);
    assert.equal(filtered.events[0].agent, 'coder');
  } finally { await srv.close(); }
});

test('GET /api/activity-log degrades to empty when no dir (never 500)', async () => {
  const meshRoot = await mkdtemp(join(tmpdir(), 'al-empty-'));
  await initMesh(meshRoot);
  const { srv, port, cookie } = await boot(meshRoot);
  try {
    const r = await fetch(`${srv.url}/api/activity-log`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie } });
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).events, []);
  } finally { await srv.close(); }
});
```

VERIFY the boot/auth harness against `test/activity-gh-merge.test.js` and copy it verbatim if it differs.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/activity-log-route.test.js`
Expected: FAIL — `/api/activity-log` 404s.

- [ ] **Step 3: Add the route in `src/dashboard/server.js`**

Add the imports (with the other `src/` imports near `buildActivity`):
```js
import { readActivity } from '../activity-log/log.js';
import { filterEvents } from '../activity-log/event.js';
```
Beside the `/api/health` route (in the authenticated `/api/*` dispatch), add — matching that route's exact structure (how `pathname`, query params, `sendJson`, and auth are handled):
```js
    if (pathname === '/api/activity-log') {
      const dir = process.env.AGENT_MESH_ACTIVITY_DIR || resolve(meshRoot, '..', '.dev-society');
      const q = (k) => { try { return new URL(req.url, 'http://x').searchParams.get(k) || undefined; } catch { return undefined; } };
      const base = readActivity({ dir, since: q('since'), limit: 500 });               // recent window
      const agents = [...new Set(base.map((e) => e.agent).filter(Boolean))].sort();
      const types = [...new Set(base.map((e) => e.type).filter(Boolean))].sort();
      const events = filterEvents(base, { agent: q('agent'), type: q('type'), level: q('level') }).slice(0, Number(q('limit')) || 200);
      sendJson(res, 200, { events, agents, types });
      return;
    }
```
ADAPT to the real query-param access (use the dashboard's existing parsed-URL/searchParams helper if there is one, instead of `new URL(req.url,...)`); use the real `sendJson`/`meshRoot`/`resolve`; do NOT duplicate imports. The route must be in the cookie-authenticated `/api/*` scope (same as `/api/health`).

- [ ] **Step 4: Run to verify it passes + no regression**

Run: `node --test test/activity-log-route.test.js` → PASS (2 tests).
Run: `node --test test/health-route.test.js test/activity-gh-merge.test.js` → PASS (sibling routes unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/server.js test/activity-log-route.test.js
git commit -m "feat(dashboard): GET /api/activity-log — filterable activity stream

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Dashboard "Activity Log" panel

**Files:**
- Modify: `src/dashboard/public/graph-view.js`, `src/dashboard/public/graph-view.css`

UI task — verification is visual (Task 7). Additive; match the existing foldable-panel pattern.

- [ ] **Step 1: Read the existing patterns FIRST**

Read `src/dashboard/public/graph-view.js`. Find the Health panel added in Phase 3 (`#sec-health` / `loadHealth`, wired in `loadAll()`): its `.sec`/`.shead[data-fold]`/`⤢ .maxbtn`/`.secbody` template, its `fetch` + render, the `esc()`/`agentColor()`/`relTime()` helpers, and how `loadAll()` calls it. Mirror that EXACTLY (same DOM idiom, same board2.css classes).

- [ ] **Step 2: Add the panel**

Add an `#sec-activity` foldable section (template like `#sec-health`) titled "Activity Log", with a `#gv-activity` body, and a `loadActivity()` that:
- fetches `/api/activity-log` with the active filters (`agent`, `type`, `since`) and renders a reverse-chronological table: `relTime(ts) · source/agent · type · summary` (+ `ref` chip; level-colored row via a class).
- renders three filter controls (agent `<select>`, type `<select>`, time-range `<select>` of today/24h/7d/all) populated from the response's `agents`/`types`; changing a filter re-fetches.
- empty state: "No activity yet." Fetch failure: "activity log unavailable."

Concrete skeleton (ADAPT names/DOM helpers to the file's real style — illustrative, not literal):
```js
const actFilters = { agent: '', type: '', since: '' };
async function loadActivity() {
  const el = document.getElementById('gv-activity'); if (!el) return;
  const qs = new URLSearchParams(Object.entries(actFilters).filter(([, v]) => v)).toString();
  let data;
  try { data = await (await fetch('/api/activity-log' + (qs ? '?' + qs : ''), { credentials: 'same-origin' })).json(); }
  catch { el.innerHTML = '<div class="gv-empty">activity log unavailable</div>'; return; }
  const { events = [], agents = [], types = [] } = data;
  // render: filter selects (agents/types/time) bound to actFilters + loadActivity(); then the rows table
  // each row: relTime(e.ts) · (e.agent ? tagName(e.agent) : e.source) · e.type · esc(e.summary) (+ ref chip)
  if (events.length === 0) { /* render filters + 'No activity yet.' */ return; }
}
```
Wire `loadActivity()` into `loadAll()` alongside `loadHealth()`/`loadSchedules()` so it folds, maximizes, and refreshes consistently. Add any needed CSS to `graph-view.css` under `#view-graph` (level pills: info/warn/error) using existing palette vars.

- [ ] **Step 3: Manual smoke (local)**

```bash
cd /Users/jingbohan/Documents/dev/agent_mesh-alwt
mkdir -p .dev-society
printf '%s\n%s\n' '{"ts":"2026-06-19T11:00:00Z","source":"daemon","agent":"coder","type":"delegate.done","level":"info","summary":"coder #98 → done","ref":"#98"}' '{"ts":"2026-06-19T11:05:00Z","source":"heartbeat","type":"heartbeat.summary","level":"warn","summary":"health: 1 overdue"}' > ".dev-society/activity-$(date -u +%Y-%m-%d).jsonl"
node --check src/dashboard/public/graph-view.js && echo "syntax OK"
# (full visual check is Task 7 — at minimum confirm syntax + that loadActivity is wired into loadAll)
rm -f .dev-society/activity-*.jsonl
```

- [ ] **Step 4: Commit**

```bash
git add src/dashboard/public/graph-view.js src/dashboard/public/graph-view.css
git commit -m "feat(dashboard): Activity Log panel — filterable agent-activity stream

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Full-suite verification + live check

- [ ] **Step 1: Run the whole suite**

Run: `npm test`
Expected: PASS — all existing + new (`activity-event` 4, `activity-log` 4, `scheduler-onjobresult` 2, `activity-log-route` 2, `activity-log-daemon` 1); 0 failures.

- [ ] **Step 2: Live-ish end-to-end (no daemon needed)**

Prove record → read round-trips through the real modules:
```bash
node -e "
import('./src/activity-log/log.js').then(async ({recordActivity, readActivity})=>{
  const dir='/tmp/al-smoke'; require('node:fs').rmSync(dir,{recursive:true,force:true});
  recordActivity({source:'daemon',type:'issue.picked',summary:'took #98',ref:'#98'},{dir});
  recordActivity({source:'scheduler',agent:'orchestrator',type:'job.run',summary:'gh-activity-poll: ok'},{dir});
  console.log(JSON.stringify(readActivity({dir}),null,1));
});
"
```
Expected: two events, newest-first, well-formed.

- [ ] **Step 3: Visual check (dashboard Activity Log panel)**

Use the `superpowers:verify` skill (real browser) against a planted `.dev-society/activity-*.jsonl` (see Task 6 Step 3) — confirm the panel renders the rows, the filters populate + work, and the empty state. Capture a screenshot.

- [ ] **Step 4: Commit (empty if clean)**

```bash
git commit --allow-empty -m "test(activity-log): verified — npm test green + record/read smoke + visual panel

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-review notes (author)

- **Spec: normalized event schema** → Task 1 (`formatEvent`). ✓
- **Spec: append/read/prune, daily rotation, fail-safe** → Task 2 (`recordActivity`/`readActivity`/`pruneActivity`). ✓
- **Spec: ~5 daemon emit points (issue/scheduler/heartbeat/gh-activity) + prune** → Task 4 + the scheduler hook in Task 3. ✓
- **Spec: read-only `/api/activity-log` filterable + facets** → Task 5. ✓
- **Spec: foldable filterable Graph-view panel** → Task 6. ✓
- **Spec: retention 30d / config** → Task 1 (consts) + Task 4 (prune wiring). ✓
- **Spec: selftest never emits** → Task 4 Step 4 (emit/prune inside `!once && !selftest`). ✓
- **Spec invariants (logging never breaks work; write-only emitters / read-only dash; high-level stream)** → fail-safe `recordActivity` (Task 2), the dashboard only reads (Task 5), one event per action (Task 4). ✓
- **Naming consistency:** `recordActivity`, `readActivity`, `pruneActivity`, `formatEvent`, `filterEvents`, `onJobResult`, `AGENT_MESH_ACTIVITY_DIR`, `DEFAULT_ACTIVITY_KEEP_DAYS`, `MAX_ACTIVITY_SUMMARY` — identical across tasks.
- **Deferred (per spec):** CLI dump; folding granular per-agent run logs; SSE live push.
