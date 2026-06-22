# Concierge Mesh Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote the phone concierge into a first-class, doctor-wired mesh agent that talks to other agents (peer bridge + mesh-health), is operated from the phone, and monitors the mesh in-the-loop (on-demand chat) and over-the-loop (autonomous sweep → phone Alerts), with observe-and-advise actions gated behind a Confirm tap.

**Architecture:** A new `dev-mesh/agents/concierge/` agent (ask-only, served) registered in `dev-mesh/mesh.json`; pure `src/concierge/monitor.js` (findings) + `src/concierge/alerts-store.js` (atomic store); a daemon builtin `concierge-monitor-sweep` that imports mesh-health core directly; `src/dashboard/concierge.js` rewired so `message()` routes to the agent via the console A2A broker and `confirm()` is an allowlisted action dispatcher; a `GET /api/concierge/alerts` route + a PWA Alerts view.

**Tech Stack:** Node ≥20, zero-dep `node --test`, ESM. Reuses `src/dashboard/console.js` (broker), `src/a2a/peer-bridge.js` (ask-only), `src/mesh-health/core.js` (`createMeshHealth`), `src/board/store.js` (`createTask`), `src/schedule/*` (cadence `{kind:'every',minutes}`), `scripts/dev-society-daemon.mjs` (builtins).

## Global Constraints

- Node >= 20; **no new dependencies** (`package.json` test script is only `node --test`).
- Agent is **ask-only**: `enabledModes:["ask"]`; never add `do`/`Bash`.
- All mutations are **framework-side and Confirm-gated**; the agent never writes the repo/mesh itself.
- Board identity is **framework-set** — `from`/`to`/`id` never taken from model input.
- Dashboard stays bound to `127.0.0.1`; token required on every `/api/*` route; no public exposure (unchanged).
- Action allowlists: labels ∈ `{idea, approved, route:a2a}`; peer ∈ the concierge's mesh peers; action ∈ `{file_issue, assign_task, ask_peer_rerun}`.
- Tests are hermetic (no real `claude`/`gh`/network); inject brokers/runners; full suite gate: `node run-all-tests.mjs`.

## File Structure

- `dev-mesh/agents/concierge/agent.json` — manifest (ask-mode)
- `dev-mesh/agents/concierge/AGENT.md` — persona (untrusted data)
- `dev-mesh/agents/concierge/.agent/schedule.json` — the sweep job
- `dev-mesh/mesh.json` — add the concierge roster entry (hand-edited, like other agents)
- `src/concierge/monitor.js` — pure: raw health inputs → deduped, severity-ranked findings
- `src/concierge/alerts-store.js` — atomic read/upsert/resolve of `<mesh-root>/mesh/alerts/alerts.json`
- `scripts/dev-society-daemon.mjs` — register builtin `concierge-monitor-sweep`
- `src/dashboard/concierge.js` — `message()`→broker; `confirm()`→action dispatcher
- `src/dashboard/server.js` — `GET /api/concierge/alerts` route
- `src/dashboard/routes-manifest.js` — register the alerts route pattern
- `src/dashboard/public/mobile/{index.html,app.js,app.css}` — Alerts tab + action cards
- `test/concierge-monitor.test.js`, `test/concierge-alerts-store.test.js`, `test/concierge-dispatch.test.js`, `test/concierge-message-route.test.js`, `test/concierge-alerts-route.test.js`, `test/concierge-wiring.test.js`, `test/mobile-pwa.test.js` (extend)

---

### Task 1: Pure monitor — findings model (severity + dedupe)

**Files:**
- Create: `src/concierge/monitor.js`
- Test: `test/concierge-monitor.test.js`

**Interfaces:**
- Produces: `buildFindings({ conformance, triage, staleTasks, mir }) -> Finding[]` where
  `Finding = { id:string, severity:'info'|'warn'|'critical', kind:string, summary:string, detail:string, source:string }`.
  Inputs are the raw shapes returned by mesh-health core + MIR (all optional/tolerant).

- [ ] **Step 1: Write the failing test**

```javascript
// test/concierge-monitor.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFindings } from '../src/concierge/monitor.js';

test('conformance failures → critical findings, deduped by id', () => {
  const f = buildFindings({ conformance: { ok: false, counts: { pass: 3, warn: 1, fail: 2 },
    problems: [{ rule: 'peer-edge', level: 'fail', detail: 'analyst→ghost missing' },
               { rule: 'peer-edge', level: 'fail', detail: 'analyst→ghost missing' }] } });
  const conf = f.filter(x => x.kind === 'conformance');
  assert.equal(conf.length, 1, 'duplicate problems collapse to one finding');
  assert.equal(conf[0].severity, 'critical');
});

test('triage failures + stale tasks classify by severity', () => {
  const f = buildFindings({
    triage: { agents: { tester: { failures: 2, recent_failures: [{ id: 'r1' }] } } },
    staleTasks: { tasks: [{ id: 't1', to: 'coder', state: 'assigned', age_ms: 9e7 }] }
  });
  assert.ok(f.some(x => x.kind === 'agent-failures' && x.severity === 'warn'));
  assert.ok(f.some(x => x.kind === 'stale-task' && x.id === 'stale-task:t1'));
});

test('all-clear inputs → no findings', () => {
  assert.deepEqual(buildFindings({ conformance: { ok: true, counts: { fail: 0 }, problems: [] },
    triage: { agents: {} }, staleTasks: { tasks: [] } }), []);
});

test('tolerates missing/empty inputs', () => {
  assert.deepEqual(buildFindings({}), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/concierge-monitor.test.js`
Expected: FAIL — `Cannot find module '../src/concierge/monitor.js'`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/concierge/monitor.js
/**
 * Pure monitor: raw mesh-health inputs → deduped, severity-ranked findings.
 * No I/O. Tolerant of missing/partial inputs (every arg optional).
 */
const SEV_RANK = { info: 0, warn: 1, critical: 2 };

function uniqBy(items, keyFn) {
  const seen = new Map();
  for (const it of items) { const k = keyFn(it); if (!seen.has(k)) seen.set(k, it); }
  return [...seen.values()];
}

export function buildFindings({ conformance, triage, staleTasks, mir } = {}) {
  const out = [];

  // Conformance fails → critical (one finding per distinct rule+detail).
  if (conformance && conformance.ok === false) {
    const problems = Array.isArray(conformance.problems) ? conformance.problems : [];
    const fails = uniqBy(problems.filter(p => p && p.level === 'fail'), p => `${p.rule}|${p.detail}`);
    for (const p of fails) {
      out.push({ id: `conformance:${p.rule}:${p.detail}`, severity: 'critical', kind: 'conformance',
        summary: `Conformance fail: ${p.rule}`, detail: String(p.detail ?? ''), source: 'check_conformance' });
    }
    if (!fails.length && (conformance.counts?.fail > 0)) {
      out.push({ id: 'conformance:counts', severity: 'critical', kind: 'conformance',
        summary: `Conformance: ${conformance.counts.fail} failing`, detail: JSON.stringify(conformance.counts), source: 'check_conformance' });
    }
  }

  // Per-agent recent failures → warn.
  const agents = (triage && triage.agents) || {};
  for (const [name, a] of Object.entries(agents)) {
    const n = Number(a?.failures) || 0;
    if (n > 0) out.push({ id: `agent-failures:${name}`, severity: 'warn', kind: 'agent-failures',
      summary: `${name}: ${n} recent failure(s)`, detail: JSON.stringify(a.recent_failures ?? []).slice(0, 500), source: 'triage_logs' });
  }

  // Stale tasks → warn.
  const tasks = (staleTasks && staleTasks.tasks) || [];
  for (const t of tasks) {
    out.push({ id: `stale-task:${t.id}`, severity: 'warn', kind: 'stale-task',
      summary: `Stale task ${t.id} (${t.to}) — ${t.state}`, detail: `age_ms=${t.age_ms}`, source: 'list_stale_tasks' });
  }

  // MIR regression signal (optional) → warn.
  if (mir && mir.regressed) out.push({ id: 'mir:regression', severity: 'warn', kind: 'mir',
    summary: 'Test/MIR regression detected', detail: String(mir.summary ?? '').slice(0, 500), source: 'mir' });

  return out.sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/concierge-monitor.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/concierge/monitor.js test/concierge-monitor.test.js
git commit -m "feat(concierge): pure monitor — findings model (severity + dedupe)"
```

---

### Task 2: Alerts store (atomic, deduped, resolve cleared)

**Files:**
- Create: `src/concierge/alerts-store.js`
- Test: `test/concierge-alerts-store.test.js`

**Interfaces:**
- Consumes: `Finding[]` from Task 1.
- Produces:
  - `readAlerts(meshRoot) -> Promise<{ alerts: Alert[], updatedAt: string|null }>` (tolerant: missing → `{alerts:[],updatedAt:null}`)
  - `syncAlerts(meshRoot, findings, now) -> Promise<Alert[]>` — upsert open findings by `id` (preserve `firstSeen`/`acknowledged`), drop alerts whose id is no longer present, bound to 200, write atomically. `Alert = Finding & { firstSeen, lastSeen, acknowledged:boolean }`.

- [ ] **Step 1: Write the failing test**

```javascript
// test/concierge-alerts-store.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAlerts, syncAlerts } from '../src/concierge/alerts-store.js';

test('missing store → empty', async () => {
  const root = await mkdtemp(join(tmpdir(), 'al-'));
  assert.deepEqual(await readAlerts(root), { alerts: [], updatedAt: null });
});

test('sync upserts, preserves firstSeen, resolves cleared', async () => {
  const root = await mkdtemp(join(tmpdir(), 'al-'));
  const f1 = { id: 'a', severity: 'warn', kind: 'k', summary: 's', detail: '', source: 'x' };
  await syncAlerts(root, [f1], '2026-06-21T10:00:00Z');
  await syncAlerts(root, [f1], '2026-06-21T11:00:00Z');           // still present
  let { alerts } = await readAlerts(root);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].firstSeen, '2026-06-21T10:00:00Z');     // preserved
  assert.equal(alerts[0].lastSeen, '2026-06-21T11:00:00Z');      // updated
  await syncAlerts(root, [], '2026-06-21T12:00:00Z');            // cleared
  ({ alerts } = await readAlerts(root));
  assert.equal(alerts.length, 0, 'resolved when no longer present');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/concierge-alerts-store.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/concierge/alerts-store.js
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';

const MAX_ALERTS = 200;
const rel = (meshRoot) => join(meshRoot, 'mesh', 'alerts', 'alerts.json');

export async function readAlerts(meshRoot) {
  try {
    const data = JSON.parse(await readFile(rel(meshRoot), 'utf8'));
    return { alerts: Array.isArray(data.alerts) ? data.alerts : [], updatedAt: data.updatedAt ?? null };
  } catch { return { alerts: [], updatedAt: null }; }
}

export async function syncAlerts(meshRoot, findings, now) {
  const prev = (await readAlerts(meshRoot)).alerts;
  const prevById = new Map(prev.map(a => [a.id, a]));
  const list = (Array.isArray(findings) ? findings : []).map(f => {
    const old = prevById.get(f.id);
    return { ...f, firstSeen: old?.firstSeen ?? now, lastSeen: now, acknowledged: old?.acknowledged ?? false };
  }).slice(0, MAX_ALERTS);
  const file = rel(meshRoot);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify({ alerts: list, updatedAt: now }, null, 2), 'utf8');
  await rename(tmp, file);   // atomic
  return list;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/concierge-alerts-store.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/concierge/alerts-store.js test/concierge-alerts-store.test.js
git commit -m "feat(concierge): atomic alerts store (upsert/resolve/bound)"
```

---

### Task 3: Action dispatcher (Confirm-gated, allowlisted)

**Files:**
- Create: `src/concierge/dispatch.js`
- Test: `test/concierge-dispatch.test.js`

**Interfaces:**
- Consumes: board `createTask` (Task uses real signature), a console broker `{send}`, a gh runner, a label allowlist.
- Produces: `dispatchAction({ action, payload, meshRoot, deps }) -> Promise<{ ok, kind, ... }>` where
  `deps = { runGh, broker, createTask, peers:string[] }`. `action ∈ {file_issue, assign_task, ask_peer_rerun}`.
  Throws `DispatchError(message,{status})` (status 400) on unknown action / disallowed peer / label **before** any side effect.

- [ ] **Step 1: Write the failing test**

```javascript
// test/concierge-dispatch.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchAction, DispatchError } from '../src/concierge/dispatch.js';

const peers = ['tester', 'triager'];

test('unknown action rejected before any side effect', async () => {
  let touched = false;
  await assert.rejects(() => dispatchAction({ action: 'rm_rf', payload: {}, meshRoot: '/x',
    deps: { runGh: async () => { touched = true; }, broker: { send: async () => { touched = true; } },
      createTask: async () => { touched = true; }, peers } }), e => e instanceof DispatchError && e.status === 400);
  assert.equal(touched, false);
});

test('file_issue runs gh with allowlisted labels only', async () => {
  let args = null;
  const out = await dispatchAction({ action: 'file_issue',
    payload: { title: 'T', body: 'b', labels: ['idea', 'evil'] }, meshRoot: '/x',
    deps: { runGh: async (a) => { args = a; return { url: 'u' }; }, broker: { send: async () => {} },
      createTask: async () => {}, peers } });
  assert.deepEqual(args.labels, ['idea'], 'evil label stripped');
  assert.equal(out.url, 'u');
});

test('assign_task rejects a non-peer, writes board for a peer with from=concierge', async () => {
  let created = null;
  await assert.rejects(() => dispatchAction({ action: 'assign_task',
    payload: { peer: 'ghost', title: 'T', objective: 'o' }, meshRoot: '/x',
    deps: { runGh: async () => {}, broker: { send: async () => {} }, createTask: async () => {}, peers } }),
    e => e.status === 400);
  const out = await dispatchAction({ action: 'assign_task',
    payload: { peer: 'tester', title: 'T', objective: 'o' }, meshRoot: '/x',
    deps: { runGh: async () => {}, broker: { send: async () => {} },
      createTask: async (root, t) => { created = t; return { id: 'tester-001' }; }, peers } });
  assert.equal(created.from, 'concierge');
  assert.equal(created.to, 'tester');
  assert.equal(out.task_id, 'tester-001');
});

test('ask_peer_rerun sends ask via broker to an allowlisted peer', async () => {
  let sent = null;
  const out = await dispatchAction({ action: 'ask_peer_rerun',
    payload: { peer: 'tester', task: 're-run the suite' }, meshRoot: '/x',
    deps: { runGh: async () => {}, createTask: async () => {},
      broker: { send: async (a) => { sent = a; return { task: { summary: 'done' } }; } }, peers } });
  assert.equal(sent.agentName, 'tester');
  assert.equal(sent.mode, 'ask');
  assert.ok(out.summary.includes('done') || out.ok);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/concierge-dispatch.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/concierge/dispatch.js
export class DispatchError extends Error {
  constructor(message, { status = 400 } = {}) { super(message); this.name = 'DispatchError'; this.status = status; }
}
const LABELS = new Set(['idea', 'approved', 'route:a2a']);
const ACTIONS = new Set(['file_issue', 'assign_task', 'ask_peer_rerun']);

export async function dispatchAction({ action, payload = {}, meshRoot, deps }) {
  if (!ACTIONS.has(action)) throw new DispatchError(`unknown action: ${action}`, { status: 400 });
  const { runGh, broker, createTask, peers = [] } = deps;

  if (action === 'file_issue') {
    const title = String(payload.title ?? '').trim();
    if (!title) throw new DispatchError('title required', { status: 400 });
    const labels = (Array.isArray(payload.labels) ? payload.labels : []).filter(l => LABELS.has(l));
    const { url } = await runGh({ title, body: String(payload.body ?? title), labels: labels.length ? labels : ['idea'], meshRoot });
    return { ok: true, kind: 'file_issue', url };
  }

  if (action === 'assign_task') {
    const peer = String(payload.peer ?? '');
    if (!peers.includes(peer)) throw new DispatchError(`peer not allowed: ${peer}`, { status: 400 });
    if (!String(payload.title ?? '').trim() || !String(payload.objective ?? '').trim())
      throw new DispatchError('title + objective required', { status: 400 });
    const { id } = await createTask(meshRoot, { from: 'concierge', to: peer,
      title: String(payload.title), objective: String(payload.objective),
      context: String(payload.context ?? ''), requirements: String(payload.requirements ?? ''), pointers: String(payload.pointers ?? '') });
    return { ok: true, kind: 'assign_task', task_id: id, to: peer };
  }

  // ask_peer_rerun
  const peer = String(payload.peer ?? '');
  if (!peers.includes(peer)) throw new DispatchError(`peer not allowed: ${peer}`, { status: 400 });
  const task = String(payload.task ?? '').trim();
  if (!task) throw new DispatchError('task required', { status: 400 });
  const res = await broker.send({ agentName: peer, mode: 'ask', text: task });
  return { ok: true, kind: 'ask_peer_rerun', peer, summary: res?.task?.summary ?? '' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/concierge-dispatch.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/concierge/dispatch.js test/concierge-dispatch.test.js
git commit -m "feat(concierge): Confirm-gated action dispatcher (file_issue/assign_task/ask_peer_rerun)"
```

---

### Task 4: Rewire `message()` to the agent broker + wire `confirm()` to the dispatcher

**Files:**
- Modify: `src/dashboard/concierge.js`
- Test: `test/concierge-message-route.test.js`

**Interfaces:**
- Consumes: `createConsoleBroker` ([src/dashboard/console.js](../../../src/dashboard/console.js)) `send({agentName,text,mode})`; `dispatchAction` (Task 3); `parseProposal` (existing in concierge.js).
- Produces: `createConcierge({ meshRoot, broker, runGh, createTask, peers })` whose `message({history,text})` calls `broker.send({agentName:'concierge', mode:'ask', text:<composed>})` and returns `{reply, proposal}` (proposal parsed from the Task summary); `confirm({action,payload})` calls `dispatchAction`.

- [ ] **Step 1: Write the failing test**

```javascript
// test/concierge-message-route.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createConcierge } from '../src/dashboard/concierge.js';

test('message routes to the concierge AGENT via the broker (ask)', async () => {
  let sent = null;
  const broker = { send: async (a) => { sent = a; return { task: { summary: 'Health is green.' } }; } };
  const c = createConcierge({ meshRoot: '/x', broker, runGh: async () => ({}), createTask: async () => ({}), peers: ['tester'] });
  const out = await c.message({ history: [], text: 'is the mesh healthy?' });
  assert.equal(sent.agentName, 'concierge');
  assert.equal(sent.mode, 'ask');
  assert.equal(out.reply, 'Health is green.');
});

test('confirm delegates to the dispatcher (file_issue)', async () => {
  let gh = null;
  const c = createConcierge({ meshRoot: '/x', broker: { send: async () => ({}) },
    runGh: async (a) => { gh = a; return { url: 'u' }; }, createTask: async () => ({}), peers: ['tester'] });
  const out = await c.confirm({ action: 'file_issue', payload: { title: 'T', labels: ['idea'] } });
  assert.equal(out.url, 'u');
  assert.deepEqual(gh.labels, ['idea']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/concierge-message-route.test.js`
Expected: FAIL — `createConcierge` signature/behavior mismatch (current one spawns claude directly).

- [ ] **Step 3: Rewrite `src/dashboard/concierge.js`**

Keep `parseProposal`, `ConciergeError`. Replace the spawn-based `createConcierge` with:

```javascript
// src/dashboard/concierge.js  (replace createConcierge + defaults; keep parseProposal/ConciergeError)
import { createConsoleBroker } from './console.js';
import { createTask as boardCreateTask } from '../board/store.js';
import { dispatchAction } from '../concierge/dispatch.js';
import { spawnFile } from '../process.js';

// default gh runner (unchanged behavior, used by the dispatcher's file_issue)
async function defaultRunGh({ title, body, labels, meshRoot }) {
  const args = ['issue', 'create', '--title', title, '--body', body || title];
  for (const l of labels) args.push('--label', l);
  const res = await spawnFile('gh', args, { cwd: meshRoot, timeoutMs: 30_000 });
  if (res.error || res.code !== 0) throw new ConciergeError('gh issue create failed', { status: 502, detail: (res.stderr||'').slice(0,500) });
  return { url: (res.stdout || '').trim().split('\n').filter(Boolean).pop() || '' };
}

const CONCIERGE_AGENT = 'concierge';

export function createConcierge({ meshRoot, broker, runGh = defaultRunGh, createTask = boardCreateTask, peers = [] } = {}) {
  const bkr = broker ?? createConsoleBroker({ meshRoot });
  return {
    async message({ history = [], text } = {}) {
      if (typeof text !== 'string' || !text.trim()) throw new ConciergeError('Empty message', { status: 400 });
      const turns = (Array.isArray(history) ? history : []).slice(-40)
        .map(m => `${m.role === 'assistant' ? 'Concierge' : 'Owner'}: ${String(m.text ?? '').slice(0, 8000)}`).join('\n');
      const composed = turns ? `${turns}\nOwner: ${text.trim()}` : text.trim();
      let res;
      try { res = await bkr.send({ agentName: CONCIERGE_AGENT, mode: 'ask', text: composed }); }
      catch (e) { throw new ConciergeError(`concierge agent error: ${e.message}`, { status: 502 }); }
      const reply = res?.task?.summary ?? '';
      return { reply: reply.replace(/```concierge-proposal[\s\S]*?```/, '').trim() || reply, proposal: parseProposal(reply) };
    },
    async confirm({ action = 'file_issue', payload = {}, title, body, labels } = {}) {
      // back-compat: a bare {title,body,labels} confirm means file_issue
      const a = action; const p = (title != null) ? { title, body, labels } : payload;
      return dispatchAction({ action: a, payload: p, meshRoot, deps: { runGh, broker: bkr, createTask, peers } });
    }
  };
}
```

Update `parseProposal` to also surface `action` (default `file_issue`) from the JSON block: in the returned object add `action: (CONFIRM-allowed ? obj.action : 'file_issue')` — accept `action ∈ {file_issue,assign_task,ask_peer_rerun}`, else `file_issue`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/concierge-message-route.test.js`
Expected: PASS. Then `node --test test/dashboard-concierge.test.js` — fix any now-stale expectations (the old message-spawn tests): update them to inject a `broker` stub and assert routing, keeping the parse/label tests.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/concierge.js test/concierge-message-route.test.js test/dashboard-concierge.test.js
git commit -m "feat(concierge): route phone chat to the concierge agent (broker) + dispatcher confirm"
```

---

### Task 5: Server wiring — construct concierge with broker+peers; `GET /api/concierge/alerts`

**Files:**
- Modify: `src/dashboard/server.js` (concierge construction + new route + handler param)
- Modify: `src/dashboard/routes-manifest.js`
- Test: `test/concierge-alerts-route.test.js`

**Interfaces:**
- Consumes: `readAlerts` (Task 2); `createConcierge` (Task 4); `readManifest` for the concierge's peers.
- Produces: route `GET /api/concierge/alerts -> { ok, alerts }`; concierge built with `{ meshRoot, broker, peers }`.

- [ ] **Step 1: Write the failing test**

```javascript
// test/concierge-alerts-route.test.js  (reuse the startServer/rawRequest helpers pattern from test/dashboard-concierge.test.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createDashboardServer } from '../src/dashboard/server.js';
import { initMesh } from '../src/builder/init-mesh.js';
import { syncAlerts } from '../src/concierge/alerts-store.js';

function raw({ port, path, headers = {} }) { return new Promise((res, rej) => {
  const r = httpRequest({ hostname: '127.0.0.1', port, path, method: 'GET', headers }, x => {
    let d = ''; x.on('data', c => d += c); x.on('end', () => res({ status: x.statusCode, body: d })); }); r.on('error', rej); r.end(); }); }

test('GET /api/concierge/alerts returns stored alerts', async () => {
  const meshRoot = await mkdtemp(join(tmpdir(), 'ca-'));
  await initMesh(meshRoot);
  await syncAlerts(meshRoot, [{ id: 'x', severity: 'warn', kind: 'k', summary: 's', detail: '', source: 'z' }], '2026-06-21T10:00:00Z');
  const srv = createDashboardServer({ meshRoot, port: 0 });
  await srv.start();
  const port = new URL(srv.url).port, token = srv.token;
  const boot = await raw({ port, path: `/?t=${token}`, headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'none' } });
  // bootstrap sets cookie via Set-Cookie; re-fetch with cookie omitted here for brevity — use the header token instead:
  try {
    const res = await raw({ port, path: '/api/concierge/alerts', headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', 'X-Dashboard-Token': token } });
    assert.equal(res.status, 200);
    const j = JSON.parse(res.body);
    assert.equal(j.ok, true);
    assert.equal(j.alerts[0].id, 'x');
  } finally { await srv.close(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/concierge-alerts-route.test.js`
Expected: FAIL — route returns 404.

- [ ] **Step 3: Implement**

In `src/dashboard/server.js`:
1. Import: `import { readAlerts } from '../concierge/alerts-store.js';`
2. Where the concierge is constructed (currently `createConcierge({ meshRoot })`), read the manifest to find the concierge's peers and pass `{ meshRoot, broker: broker, peers }` (reuse the dashboard's existing console `broker` instance). Peers: from `readManifest(meshRoot)` agent named `concierge` → `.peers ?? []` (default `[]` if the agent isn't in the mesh yet, so the dashboard still boots).
3. Add the route, right beside the existing concierge routes:

```javascript
if (pathname === '/api/concierge/alerts' && req.method === 'GET') {
  const { alerts } = await readAlerts(meshRoot);
  sendJson(res, 200, { ok: true, alerts });
  return;
}
```

In `src/dashboard/routes-manifest.js` add: `/^\/api\/concierge\/alerts$/, // GET /api/concierge/alerts`.

- [ ] **Step 4: Run tests**

Run: `node --test test/concierge-alerts-route.test.js test/deadcode-routes-equivalence.test.js`
Expected: PASS both (route registered in the manifest).

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/server.js src/dashboard/routes-manifest.js test/concierge-alerts-route.test.js
git commit -m "feat(concierge): GET /api/concierge/alerts + build concierge with broker+peers"
```

---

### Task 6: Daemon sweep builtin `concierge-monitor-sweep`

**Files:**
- Modify: `scripts/dev-society-daemon.mjs` (register builtin)
- Create: `src/concierge/sweep.js` (testable orchestration: gather inputs → buildFindings → syncAlerts)
- Test: `test/concierge-sweep.test.js`

**Interfaces:**
- Consumes: `createMeshHealth` ([src/mesh-health/core.js](../../../src/mesh-health/core.js)) verbs, `buildFindings`, `syncAlerts`.
- Produces: `runSweep({ meshRoot, health, now }) -> Promise<{ status, output }>` (health injectable for tests); the daemon builtin calls `runSweep({ meshRoot, health: createMeshHealth({ meshRoot }), now: new Date().toISOString() })`.

- [ ] **Step 1: Write the failing test**

```javascript
// test/concierge-sweep.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSweep } from '../src/concierge/sweep.js';
import { readAlerts } from '../src/concierge/alerts-store.js';

test('sweep gathers health, writes alerts, returns ok', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sw-'));
  const health = {
    checkConformance: async () => ({ ok: false, counts: { fail: 1 }, problems: [{ rule: 'r', level: 'fail', detail: 'd' }] }),
    triageLogs: async () => ({ agents: {} }),
    listStaleTasks: async () => ({ tasks: [] })
  };
  const out = await runSweep({ meshRoot: root, health, now: '2026-06-21T10:00:00Z' });
  assert.equal(out.status, 'ok');
  const { alerts } = await readAlerts(root);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, 'critical');
});

test('sweep tolerates a failing verb (never throws)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sw-'));
  const health = { checkConformance: async () => { throw new Error('boom'); },
    triageLogs: async () => ({ agents: {} }), listStaleTasks: async () => ({ tasks: [] }) };
  const out = await runSweep({ meshRoot: root, health, now: '2026-06-21T10:00:00Z' });
  assert.equal(out.status, 'ok');   // partial inputs → still completes
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/concierge-sweep.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/concierge/sweep.js`**

```javascript
// src/concierge/sweep.js
import { buildFindings } from './monitor.js';
import { syncAlerts } from './alerts-store.js';

const safe = async (fn) => { try { return await fn(); } catch { return undefined; } };

export async function runSweep({ meshRoot, health, now }) {
  try {
    const [conformance, triage, staleTasks] = await Promise.all([
      safe(() => health.checkConformance?.()),
      safe(() => health.triageLogs?.({ since_hours: 24 })),
      safe(() => health.listStaleTasks?.({})),
    ]);
    const findings = buildFindings({ conformance, triage, staleTasks });
    await syncAlerts(meshRoot, findings, now);
    return { status: 'ok', output: `concierge sweep: ${findings.length} alert(s)` };
  } catch (err) {
    return { status: 'fail', error: String(err?.message ?? err) };
  }
}
```

- [ ] **Step 4: Register the builtin in `scripts/dev-society-daemon.mjs`**

In the `const builtins = { ... }` object (~line 100), add:

```javascript
'concierge-monitor-sweep': async () => {
  const { createMeshHealth } = await import('../src/mesh-health/core.js');
  const { runSweep } = await import('../src/concierge/sweep.js');
  return runSweep({ meshRoot, health: createMeshHealth({ meshRoot }), now: new Date().toISOString() });
},
```

(Use the daemon's existing `meshRoot` binding; match the surrounding builtins' style for imports.)

- [ ] **Step 5: Run tests + commit**

Run: `node --test test/concierge-sweep.test.js`
Expected: PASS.

```bash
git add src/concierge/sweep.js scripts/dev-society-daemon.mjs test/concierge-sweep.test.js
git commit -m "feat(concierge): over-the-loop monitor sweep builtin (read-only)"
```

---

### Task 7: The agent folder + mesh.json entry + schedule + doctor wiring

**Files:**
- Create: `dev-mesh/agents/concierge/agent.json`, `dev-mesh/agents/concierge/AGENT.md`, `dev-mesh/agents/concierge/.agent/schedule.json`
- Modify: `dev-mesh/mesh.json` (add the roster entry)
- Test: `test/concierge-wiring.test.js`

**Interfaces:**
- Consumes: `doctor` ([src/builder/doctor.js](../../../src/builder/doctor.js)), `loadSnapshot`/conformance.
- Produces: a served, ask-only `concierge` agent with peers `[tester, triager, analyst, maintainer, orchestrator]`, peer-bridge + mesh-health + board hook wired.

- [ ] **Step 1: Write the failing test**

```javascript
// test/concierge-wiring.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MESH = join('dev-mesh', 'mesh.json');

test('concierge is registered as a served ask-only agent with monitoring peers', () => {
  const m = JSON.parse(readFileSync(MESH, 'utf8'));
  const c = m.agents.find(a => a.name === 'concierge');
  assert.ok(c, 'concierge in mesh.json');
  assert.equal(c.served, true);
  assert.deepEqual(c.enabledModes, ['ask']);
  for (const p of ['tester', 'triager', 'analyst']) assert.ok(c.peers.includes(p), `peer ${p}`);
});

test('concierge agent.json is ask-only', () => {
  const a = JSON.parse(readFileSync(join('dev-mesh', 'agents', 'concierge', 'agent.json'), 'utf8'));
  assert.equal(a.name, 'concierge');
  assert.deepEqual(a['x-agentmesh'].modes, ['ask']);
});

test('concierge schedule runs the monitor sweep', () => {
  const s = JSON.parse(readFileSync(join('dev-mesh', 'agents', 'concierge', '.agent', 'schedule.json'), 'utf8'));
  const job = s.jobs.find(j => j.builtin === 'concierge-monitor-sweep');
  assert.ok(job && job.kind === 'builtin' && job.enabled);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/concierge-wiring.test.js`
Expected: FAIL — files/entry missing.

- [ ] **Step 3: Create the agent files**

`dev-mesh/agents/concierge/agent.json`:
```json
{
  "protocolVersion": "1.0",
  "name": "concierge",
  "description": "Phone-side mesh monitor and front-desk: answers status by asking peers + mesh-health, runs an over-the-loop monitoring sweep, and proposes Confirm-gated actions.",
  "version": "0.1.0",
  "defaultInputModes": ["text/plain"],
  "defaultOutputModes": ["text/plain", "application/json"],
  "skills": [
    { "id": "mesh-status", "name": "Mesh status", "description": "Ask peers + mesh-health to report health, blocked work, and recent activity.", "tags": ["monitor"] },
    { "id": "propose-action", "name": "Propose action", "description": "Propose a Confirm-gated action (file an issue, assign a task, ask a peer to re-run).", "tags": ["advise"] }
  ],
  "x-agentmesh": { "modes": ["ask"], "meshVersion": "0.1.0" }
}
```

`dev-mesh/agents/concierge/AGENT.md` (persona — data, not instructions to the framework):
```markdown
# Concierge

The mesh's phone-side monitor and front-desk. Answer the owner's questions about the mesh's
health and progress by consulting peers (tester, triager, analyst, maintainer, orchestrator)
and the mesh-health verbs — not by guessing. Be concise; you are on a phone screen.

When the owner wants to act, emit ONE fenced proposal block and stop — never act yourself:

```concierge-proposal
{"action":"file_issue","title":"...","body":"...","labels":["idea"]}
```

Valid actions: file_issue (labels idea/approved/route:a2a), assign_task (peer + title + objective),
ask_peer_rerun (peer + task). The owner taps Confirm; the framework performs the action. If the
owner is only asking for status, reply normally with no block.
```

`dev-mesh/agents/concierge/.agent/schedule.json`:
```json
{
  "jobs": [
    { "id": "concierge-monitor-sweep", "name": "concierge-monitor-sweep — over-the-loop mesh health sweep",
      "kind": "builtin", "builtin": "concierge-monitor-sweep",
      "cadence": { "kind": "every", "minutes": 60 }, "enabled": true, "saveArtifact": false }
  ]
}
```

- [ ] **Step 4: Add the mesh.json roster entry**

Add to the `agents` array in `dev-mesh/mesh.json` (match the existing entry shape):
```json
{ "name": "concierge", "root": "./concierge", "card": "agent.json", "served": true, "enabledModes": ["ask"], "peers": ["tester", "triager", "analyst", "maintainer", "orchestrator"] }
```

- [ ] **Step 5: Wire with doctor + verify**

Run: `node ./bin/agent-mesh.js doctor dev-mesh --apply` (generates concierge registry.json, peer-bridge `.mcp.json`, board hook).
Then: `node --test test/concierge-wiring.test.js` → PASS.
Then conformance: `node ./bin/agent-mesh.js doctor dev-mesh` (dry-run) → no fails for concierge.

- [ ] **Step 6: Commit**

```bash
git add dev-mesh/agents/concierge dev-mesh/mesh.json test/concierge-wiring.test.js
git commit -m "feat(concierge): register the concierge mesh agent (served, ask-only, peered) + sweep schedule"
```

---

### Task 8: PWA Alerts tab + action proposal cards

**Files:**
- Modify: `src/dashboard/public/mobile/index.html` (Alerts tab + view)
- Modify: `src/dashboard/public/mobile/app.js` (fetch alerts; render; action cards)
- Modify: `src/dashboard/public/mobile/app.css` (severity colors)
- Test: `test/mobile-pwa.test.js` (extend)

**Interfaces:**
- Consumes: `GET /api/concierge/alerts` (Task 5); `summarizeActivity`/`escapeHtml` patterns (existing).
- Produces: `summarizeAlerts(alerts) -> { title, rows:[{label,value,cls}] }` (pure, exported).

- [ ] **Step 1: Write the failing test**

```javascript
// add to test/mobile-pwa.test.js
import { summarizeAlerts } from '../src/dashboard/public/mobile/app.js';

test('summarizeAlerts ranks by severity with colour', () => {
  const card = summarizeAlerts([
    { id: 'a', severity: 'warn', summary: 'stale task t1' },
    { id: 'b', severity: 'critical', summary: 'conformance fail' }
  ]);
  assert.equal(card.rows[0].cls, 'bad');         // critical first
  assert.equal(card.rows[0].label.includes('conformance fail'), true);
  assert.equal(summarizeAlerts([]).rows[0].value, '—');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/mobile-pwa.test.js`
Expected: FAIL — `summarizeAlerts` not exported.

- [ ] **Step 3: Implement**

In `src/dashboard/public/mobile/app.js`, add (pure, before `mount`):
```javascript
const SEV = { critical: 'bad', warn: 'warn', info: '' };
export function summarizeAlerts(alerts) {
  const list = Array.isArray(alerts) ? alerts.slice().sort((a,b)=>({critical:2,warn:1,info:0}[b.severity]||0)-({critical:2,warn:1,info:0}[a.severity]||0)) : [];
  if (!list.length) return { title: 'Alerts', rows: [{ label: 'No alerts', value: '—', cls: 'muted' }] };
  return { title: 'Alerts', rows: list.map(a => ({ label: a.summary || a.kind || a.id, value: a.severity, cls: SEV[a.severity] || '' })) };
}
```
In `mount()`: add a third tab `Alerts` (data-view="alerts") + a `view-alerts` section; on tab select, `fetch('/api/concierge/alerts', {headers:authHeaders()})` → render `summarizeAlerts(data.alerts)` into a card (reuse the `.card/.metric` markup from the status renderer). Add the tab button to `index.html` and a `#view-alerts` section; add `.bad`/`.warn` are already defined in app.css (no new CSS needed beyond what exists).

- [ ] **Step 4: Run tests**

Run: `node --test test/mobile-pwa.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/public/mobile/ test/mobile-pwa.test.js
git commit -m "feat(concierge): phone Alerts tab (over-the-loop findings)"
```

---

### Task 9: Full-suite gate, docs, and live verification

**Files:**
- Modify: `CLAUDE.md` (note the concierge agent in the roster / architecture)

- [ ] **Step 1: Run the full suite**

Run: `node run-all-tests.mjs`
Expected: all green (the new test files + unchanged suite). Fix any regressions (esp. `test/dashboard-concierge.test.js` from Task 4, `test/deadcode-routes-equivalence.test.js` from Task 5).

- [ ] **Step 2: Update CLAUDE.md**

Add one line to the architecture/agent list noting `concierge` as the 10th agent: phone-operated, ask-only monitor; peers tester/triager/analyst/maintainer/orchestrator; over-the-loop sweep builtin `concierge-monitor-sweep`; Confirm-gated dispatcher. Reference the spec.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(concierge): note the concierge agent in the roster + architecture"
```

- [ ] **Step 4: PR + merge + deploy-sync ships it; then live-verify**

Open a PR, let CI go green, squash-merge. deploy-sync ships to the running dashboard + daemon; `doctor` wires the agent on the managed sync. Live-verify on the Mac+phone:
- Phone chat "is the mesh healthy?" → answer is peer/health-sourced (the agent ran, not a file scrape).
- Force a sweep (`node ./bin/agent-mesh.js ...` once, or wait for the cadence) → an alert appears in the phone **Alerts** tab.
- Tap a finding → proposal card → **Confirm** → exactly one framework action (issue/task/peer re-run).

---

## Self-Review

**Spec coverage:** §1 agent → Task 7; §2 talks-to-peers → Task 7 (peers + bridge via doctor) exercised in Task 4 routing; §3 phone operation → Tasks 4–5; §4 sweep+alerts → Tasks 1,2,6 + route 5 + PWA 8; §5 action boundary → Task 3 dispatcher + Task 4 confirm. Security invariants → ask-only manifest (7), allowlists (3), framework-set board identity (3). Testing section → Tasks 1–8 each ship tests. All spec sections map to a task.

**Placeholder scan:** none — every code step has full code; commands have expected output.

**Type consistency:** `buildFindings`→`Finding{id,severity,kind,summary,detail,source}` (T1) consumed by `syncAlerts` (T2) and `summarizeAlerts` (T8); `dispatchAction({action,payload,meshRoot,deps})` (T3) consumed by `confirm` (T4) and the route (T5); `broker.send({agentName,text,mode})` matches `console.js`; `createTask(meshRoot,{from,to,title,objective,...})` matches `board/store.js`; `runSweep({meshRoot,health,now})` (T6) uses `health.checkConformance/triageLogs/listStaleTasks` matching `createMeshHealth`. Consistent.
