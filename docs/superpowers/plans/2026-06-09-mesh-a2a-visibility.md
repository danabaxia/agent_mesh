# Mesh-Level A2A Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every `delegate_to_peer` (B→C) attempt visible in the dashboard — including refusals and spawn failures the existing `delegate-*` logs miss — via a new `a2a-*.jsonl` audit log surfaced as explicit, text-free activity edges, plus a peer-session provenance fix.

**Architecture:** The peer bridge writes a dated `a2a-*.jsonl` under the **caller** agent (reusing `createRunLog`'s `prefix` param), recording a `started`+`done` pair on send and a single `done` on a pre-send refusal. The dashboard activity loader scans `a2a-*` alongside `delegate-*`; `buildActivity` turns `kind:"a2a"` records into explicit `from→to` edges (superseding the inferred `parent_run_id` edge for the same pair) and text-free events. Separately, peer-session labels are re-keyed by mesh root so they show as `from:<caller>`.

**Tech Stack:** Node ≥20, zero-dependency ESM, `node --test`. Bridge tests inject a fake A2A client (`createClient`); activity tested via `buildActivity` (pure) + the `/api/activity` route on `createDashboardServer`.

**Spec:** [docs/superpowers/specs/2026-06-09-mesh-a2a-visibility-design.md](../specs/2026-06-09-mesh-a2a-visibility-design.md)

---

## File structure

| File | Responsibility | Change |
|---|---|---|
| `src/a2a/peer-bridge.js` | write `a2a-*` start/done/refusal records around `delegateToPeer` | Modify |
| `src/dashboard/activity.js` | split records by `kind`; explicit a2a edges + events; edge dedupe | Modify |
| `src/dashboard/server.js` | `loadActivitySnapshot` scans `a2a-*` too | Modify (1 line) |
| `src/a2a/stdio-server.js` | key peer-session label/event by mesh root, not agent root | Modify |
| `test/peer-bridge.test.js` | a2a-log records on success + refusal/failure | Modify |
| `test/dashboard-activity.test.js` | a2a edges/events, dedupe, no-leak, loader scans a2a-* | Modify |
| `test/multi-turn-delegate.test.js` | provenance: label keyed by mesh root | Modify |

No new files — `src/log.js` already supports the `'a2a'` prefix.

---

## Task 1: Peer bridge writes the `a2a-*` audit log

**Files:**
- Modify: `src/a2a/peer-bridge.js` (`delegateToPeer`, lines 63-120; add imports)
- Test: `test/peer-bridge.test.js`

- [ ] **Step 1: Write the failing tests** — append to `test/peer-bridge.test.js`. They reuse the existing `meshAgentRootWith`, `fakeClientFactory`, `doneTask`, `MARKED` helpers already in that file. Add these imports at the top of the file:

```js
import { readRunLogRecords, dedupeRunRecords } from '../src/log.js';
import { readdir } from 'node:fs/promises';

// Read all a2a records written under an agent root (newest date file).
async function readA2aRecords(root) {
  const dir = join(root, '.agent-mesh', 'logs');
  let files = [];
  try { files = await readdir(dir); } catch { return []; }
  const a2a = files.filter((f) => f.startsWith('a2a-') && f.endsWith('.jsonl')).sort();
  const out = [];
  for (const f of a2a) out.push(...await readRunLogRecords(join(dir, f)));
  return out;
}
```

Then the tests:

```js
test('delegateToPeer(ask) writes a2a started+done records under the caller root', async () => {
  const { root, meshRoot, name } = await meshAgentRootWith(MARKED);
  const { factory } = fakeClientFactory();                       // doneTask(): completed, log_path /logs/t1.json
  const bridge = createBridge({ root, env: { AGENT_MESH_MESH_CEILING: meshRoot, AGENT_MESH_RUN_ID: 'run-parent' }, createClient: factory });

  await bridge.delegateToPeer({ peer: 'library', mode: 'ask', task: 'find Dune' });

  const recs = await readA2aRecords(root);
  const started = recs.find((r) => r.state === 'started');
  const done = recs.find((r) => r.state === 'done');
  assert.ok(started && done, 'both a2a records written');
  assert.equal(started.id, done.id, 'start+done share one id');
  assert.equal(done.kind, 'a2a');
  assert.equal(done.from, name);
  assert.equal(done.to, 'library');
  assert.equal(done.mode, 'ask');
  assert.equal(done.parent_run_id, 'run-parent');
  assert.equal(done.status, 'completed');
  assert.equal(done.child_log_path, '/logs/t1.json');           // on-disk only
  assert.ok(typeof done.finished_at === 'string');
});

test('delegateToPeer refusal (mode_disabled) writes a single a2a done:rejected record, no started', async () => {
  const { root, meshRoot } = await meshAgentRootWith(MARKED);
  const { factory, calls } = fakeClientFactory();
  const bridge = createBridge({ root, env: { AGENT_MESH_MESH_CEILING: meshRoot }, createClient: factory });

  const res = await bridge.delegateToPeer({ peer: 'library', mode: 'do', task: 'rm -rf' });
  assert.equal(res.error_code, 'mode_disabled');
  assert.equal(calls.factory.length, 0, 'no peer spawn');

  const recs = await readA2aRecords(root);
  assert.equal(recs.filter((r) => r.state === 'started').length, 0, 'no started record on a pre-send refusal');
  const done = recs.find((r) => r.state === 'done');
  assert.ok(done, 'a refusal is still recorded');
  assert.equal(done.status, 'rejected');
  assert.equal(done.error_code, 'mode_disabled');
  assert.equal(done.to, 'library');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/peer-bridge.test.js`
Expected: FAIL — no `.agent-mesh/logs/a2a-*.jsonl` is written (`readA2aRecords` returns `[]`).

- [ ] **Step 3: Implement the a2a logging in `delegateToPeer`** — in `src/a2a/peer-bridge.js`:

3a. Add imports near the top (with the other imports):

```js
import { createRunLog, appendRunLog } from '../log.js';
```

3b. Add a small helper below the `refusal` function:

```js
// summary_preview is on-disk only; cap and scrub obvious absolute paths.
function previewOf(summary) {
  if (typeof summary !== 'string' || !summary) return null;
  return summary.replace(/(?:[A-Za-z]:\\|\/)[^\s'"]+/g, '[path]').slice(0, 200);
}
```

3c. Rewrite the body of `delegateToPeer` to thread logging through every exit. Replace the function (lines 63-120) with:

```js
  async function delegateToPeer({ peer, mode = ONWARD_MODE, task, new_conversation = false } = {}) {
    const startedAt = new Date().toISOString();
    const from = await resolveCallerName(root, env).catch(() => null);  // best-effort, for logging even on refusal
    let logState = null;                                                // { logPath, id } — created lazily, once
    const ensureLog = async () => {
      if (!logState) { const { logPath, runId } = await createRunLog(root, env, 'a2a'); logState = { logPath, id: runId }; }
      return logState;
    };
    const a2aBase = () => ({
      kind: 'a2a', from, to: typeof peer === 'string' ? peer : null, mode,
      parent_run_id: env?.AGENT_MESH_RUN_ID || null, started_at: startedAt
    });
    const logRec = async (fields) => {
      try { const { logPath, id } = await ensureLog(); await appendRunLog(logPath, { ...a2aBase(), id, ...fields }); }
      catch (e) { process.stderr.write(`[agent-mesh] a2a log append failed: ${e.message}\n`); }
    };
    const refuseLogged = async (code, message) => {
      await logRec({ state: 'done', finished_at: new Date().toISOString(), message_id: null, status: 'rejected', error_code: code });
      return refusal(code, message, peer);
    };

    // v1 ask-only capability gate — refuse BEFORE any spawn.
    if (mode !== ONWARD_MODE) {
      return refuseLogged('mode_disabled', `Onward delegation is ask-only in v1; mode "${mode}" is disabled.`);
    }
    if (typeof peer !== 'string' || peer.length === 0) return refuseLogged('bad_input', 'peer name is required.');
    if (typeof task !== 'string' || task.trim().length < 1) return refuseLogged('bad_input', 'task text is required.');
    if (task.length > MAX_TASK_CHARS) return refuseLogged('bad_input', `task exceeds the ${MAX_TASK_CHARS}-character limit.`);

    const managed = await readManagedRegistry(root);
    if (!managed.ok) return refuseLogged('bad_input', `no managed registry (${managed.reason}); the bridge offers no peers.`);
    if (!managed.registry.peers[peer]) return refuseLogged('bad_input', `peer "${peer}" is not in this agent's registry.`);

    if (!from) {
      return refuseLogged('caller_identity_unresolved',
        'cannot resolve a unique caller name from the mesh manifest; refusing to risk a colliding session key.');
    }

    let client;
    try {
      client = await createClient(managed.registry, { env, protectedEnv: RESERVED_BRIDGE_ENV, requestTimeoutMs });
    } catch (err) {
      return refuseLogged('spawn_failed', `failed to spawn peer "${peer}": ${err.message}`);
    }

    const message = {
      messageId: randomUUID(),
      role: 'ROLE_USER',
      parts: [{ text: task }],
      metadata: { 'agentmesh/mode': ONWARD_MODE, 'agentmesh/caller': from }
    };
    const parentRunId = env?.AGENT_MESH_RUN_ID;
    if (parentRunId) message.metadata['agentmesh/parent_run_id'] = parentRunId;
    if (new_conversation === true) message.metadata['agentmesh/reset_conversation'] = true;

    await logRec({ state: 'started', message_id: message.messageId });
    try {
      const taskResult = await client.send(peer, message);
      const mapped = mapTask(peer, taskResult);
      await logRec({
        state: 'done', finished_at: new Date().toISOString(), message_id: message.messageId,
        status: mapped.status, error_code: mapped.error_code,
        child_log_path: mapped.log_path || null,
        child_run_id: (taskResult?.metadata || {})['agentmesh/run_id'] || null,
        summary_preview: previewOf(mapped.summary)
      });
      return mapped;
    } catch (err) {
      await logRec({ state: 'done', finished_at: new Date().toISOString(), message_id: message.messageId, status: 'error', error_code: 'spawn_failed' });
      return refusal('spawn_failed', err.message, peer);
    } finally {
      await client.close().catch(() => {});
    }
  }
```

> This preserves the exact gate order and return values of the original (the existing gate tests still pass); it only resolves `from` once up front (for logging) and wraps each exit with a log append. The `agentmesh/caller` metadata now reuses the already-resolved `from` instead of re-resolving.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/peer-bridge.test.js`
Expected: PASS — the two new tests plus all pre-existing bridge tests (gate order, mapping, audit propagation) stay green.

- [ ] **Step 5: Commit**

```bash
git add src/a2a/peer-bridge.js test/peer-bridge.test.js
git commit -m "feat(bridge): write a2a-* audit log for every delegate_to_peer (incl. refusals)"
```

---

## Task 2: Activity model renders explicit a2a edges (text-free, deduped)

**Files:**
- Modify: `src/dashboard/activity.js` (`buildActivity`)
- Test: `test/dashboard-activity.test.js`

- [ ] **Step 1: Write the failing tests** — append to `test/dashboard-activity.test.js`:

```js
test('buildActivity: a kind:"a2a" record yields an explicit from→to edge (no parent_run_id needed)', () => {
  const { edges } = buildActivity([
    { kind: 'a2a', id: 'x1', from: 'data-analyst', to: 'knowledge', mode: 'ask',
      started_at: '2026-06-09T10:00:00Z', finished_at: '2026-06-09T10:00:03Z', status: 'completed' }
  ]);
  const e = edges.find((e) => e.from === 'data-analyst' && e.to === 'knowledge');
  assert.ok(e, 'explicit a2a edge present');
  assert.equal(e.kind, 'a2a');
  assert.equal(e.active, false);
});

test('buildActivity: a2a edge supersedes the inferred parent_run_id edge for the same pair (no duplicate)', () => {
  const { edges } = buildActivity([
    { agent: 'data-analyst', id: 'P', started_at: '2026-06-09T10:00:00Z' },
    { agent: 'knowledge', id: 'C', parent_run_id: 'P', started_at: '2026-06-09T10:00:01Z' },
    { kind: 'a2a', id: 'x1', from: 'data-analyst', to: 'knowledge', mode: 'ask',
      started_at: '2026-06-09T10:00:01Z', status: 'completed', finished_at: '2026-06-09T10:00:02Z' }
  ]);
  const pair = edges.filter((e) => e.from === 'data-analyst' && e.to === 'knowledge');
  assert.equal(pair.length, 1, 'exactly one edge for the pair');
  assert.equal(pair[0].kind, 'a2a', 'the explicit a2a edge wins');
});

test('buildActivity: a2a records never leak child_log_path / summary_preview to the view-model', () => {
  const model = buildActivity([
    { kind: 'a2a', id: 'x1', from: 'data-analyst', to: 'knowledge', mode: 'ask', status: 'completed',
      started_at: '2026-06-09T10:00:00Z', finished_at: '2026-06-09T10:00:01Z',
      child_log_path: '/secret/logs/x.jsonl', summary_preview: 'sensitive text' }
  ]);
  const blob = JSON.stringify(model);
  assert.equal(blob.includes('/secret/logs/x.jsonl'), false, 'no child_log_path on the board');
  assert.equal(blob.includes('sensitive text'), false, 'no summary_preview on the board');
  // a text-free a2a event is present
  const ev = model.events.find((e) => e.kind === 'a2a');
  assert.ok(ev && ev.from === 'data-analyst' && ev.to === 'knowledge' && ev.status === 'completed');
});

test('buildActivity: a2a records do not create phantom agents in the state list', () => {
  const { agents } = buildActivity([
    { kind: 'a2a', id: 'x1', from: 'data-analyst', to: 'knowledge', mode: 'ask',
      started_at: '2026-06-09T10:00:00Z', status: 'completed', finished_at: '2026-06-09T10:00:01Z' }
  ]);
  assert.equal(agents.length, 0, 'an a2a traffic record is not an agent state');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/dashboard-activity.test.js`
Expected: FAIL — `buildActivity` treats a2a records like delegate records (no `r.agent` → filtered out at line 28), so no a2a edge/event and possibly a phantom.

- [ ] **Step 3: Implement in `src/dashboard/activity.js`** — split records by `kind` and merge edges. Replace `buildActivity` (lines 27-68) with:

```js
export function buildActivity(records) {
  const all = Array.isArray(records) ? records : [];
  const a2a = all.filter((r) => r && r.kind === 'a2a' && r.from && r.to);
  const list = all.filter((r) => r && r.kind !== 'a2a' && r.agent);

  // Latest record per agent → state (status only, no text). a2a records excluded.
  const byAgent = new Map();
  for (const r of list) {
    const t = ts(r.started_at);
    const prev = byAgent.get(r.agent);
    if (!prev || t >= prev._t) byAgent.set(r.agent, { ...r, _t: t });
  }
  const agents = [...byAgent.values()].map((r) => ({
    name: r.agent,
    state: r.finished_at ? 'done' : 'working',
    route: r.route || null,
    since: r.started_at || null
  }));

  // Edges, keyed by `from|to`. Explicit a2a edges are authoritative and SUPERSEDE
  // an inferred parent_run_id edge for the same ordered pair (they work without
  // AGENT_MESH_RUN_ID and carry kind). active = OR across contributing edges.
  const edgeMap = new Map();
  const addEdge = (from, to, active, kind) => {
    if (from === to) return;
    const key = `${from} ${to}`;
    const prev = edgeMap.get(key);
    if (!prev) { edgeMap.set(key, { from, to, active, kind }); return; }
    prev.active = prev.active || active;
    if (kind === 'a2a') prev.kind = 'a2a';        // explicit wins
  };
  const byId = new Map(list.filter((r) => r.id).map((r) => [r.id, r]));
  for (const r of list) {
    if (!r.parent_run_id) continue;
    const parent = byId.get(r.parent_run_id);
    if (!parent || parent.agent === r.agent) continue;
    addEdge(parent.agent, r.agent, !r.finished_at, 'delegate');
  }
  for (const r of a2a) addEdge(r.from, r.to, !r.finished_at, 'a2a');
  const edges = [...edgeMap.values()];

  // Bounded, time-ordered phase feed. delegate → {kind:start|done, agent, route};
  // a2a → text-free {kind:'a2a', from, to, mode, status}. No text content.
  const events = [...list, ...a2a]
    .slice()
    .sort((a, b) => ts(a.started_at) - ts(b.started_at))
    .slice(-MAX_EVENTS)
    .map((r) => r.kind === 'a2a'
      ? { kind: 'a2a', from: r.from, to: r.to, mode: r.mode || null, status: r.status || null, at: r.finished_at || r.started_at || null }
      : { kind: r.finished_at ? 'done' : 'start', agent: r.agent, route: r.route || null, at: r.finished_at || r.started_at || null });

  return { agents, edges, events };
}
```

> The view-model still emits only whitelisted fields, so `child_log_path`/`summary_preview` are structurally impossible on the board (the no-leak guarantee), now covering a2a records too.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/dashboard-activity.test.js`
Expected: PASS — the four new tests plus the existing state/edge tests (delegate-only behavior is unchanged: a delegate record still keys on `r.agent`, parent edges still drawn).

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/activity.js test/dashboard-activity.test.js
git commit -m "feat(dashboard): explicit a2a activity edges (text-free, supersede inferred edge)"
```

---

## Task 3: Activity loader scans `a2a-*` files

**Files:**
- Modify: `src/dashboard/server.js` (`loadActivitySnapshot`, line 351-352)
- Test: `test/dashboard-activity.test.js` (the `/api/activity` route section)

- [ ] **Step 1: Write the failing test** — append to `test/dashboard-activity.test.js`. Reuse the existing `meshWithLogs()` helper (creates a mesh with agent `alpha`) and the existing authenticated-`fetch` pattern (the route is auth-gated; `server.inject` does not exist here). Add an a2a file under `alpha`, then assert the edge appears in the snapshot:

```js
test('/api/activity surfaces an a2a edge from an a2a-*.jsonl log', async () => {
  const meshRoot = await meshWithLogs();                       // existing helper: mesh + agent 'alpha'
  const logDir = join(meshRoot, 'alpha', '.agent-mesh', 'logs');
  await writeFile(
    join(logDir, 'a2a-2026-06-09.jsonl'),
    JSON.stringify({ kind: 'a2a', id: 'x1', from: 'alpha', to: 'beta', mode: 'ask', state: 'done',
      status: 'completed', started_at: '2026-06-09T10:00:00Z', finished_at: '2026-06-09T10:00:01Z',
      child_log_path: '/secret/x.jsonl', summary_preview: 'sensitive' }) + '\n',
    'utf8'
  );

  const srv = createDashboardServer({ meshRoot, port: 0, watchPollMs: 100 });
  await srv.start();
  const port = new URL(srv.url).port;
  const boot = await fetch(`${srv.url}/?t=${srv.token}`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'none' }, redirect: 'manual' });
  const cookie = `am_dash=${boot.headers.get('set-cookie').match(/am_dash=([^;]+)/)[1]}`;
  try {
    const res = await fetch(`${srv.url}/api/activity`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    const edge = body.edges.find((e) => e.from === 'alpha' && e.to === 'beta' && e.kind === 'a2a');
    assert.ok(edge, 'a2a edge surfaced through the loader');
    const blob = JSON.stringify(body);
    assert.ok(!blob.includes('/secret/x.jsonl') && !blob.includes('sensitive'), 'no on-disk-only a2a fields leak');
  } finally {
    await srv.close();
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/dashboard-activity.test.js`
Expected: FAIL — `loadActivitySnapshot` filters only `delegate-*`, so the a2a file is ignored and the edge is absent.

- [ ] **Step 3: Implement the one-line filter widening** in `src/dashboard/server.js` (line 351-352):

```js
    const logFiles = files
      .filter((f) => (f.startsWith('delegate-') || f.startsWith('a2a-')) && (f.endsWith('.jsonl') || f.endsWith('.json')))
      .sort()
      .slice(-ACTIVITY_DATE_FILES);
```

> Records keep getting `agent: agent.name` stamped at line 364 — harmless for a2a records (`buildActivity` routes them by `kind`, using `from`/`to`). `dedupeRunRecords` already collapses a2a start+done by `id`.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/dashboard-activity.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/server.js test/dashboard-activity.test.js
git commit -m "feat(dashboard): activity loader scans a2a-* logs alongside delegate-*"
```

---

## Task 4: Peer-session provenance keyed by mesh root

**Files:**
- Modify: `src/a2a/stdio-server.js` (`deriveCallerSession`, lines 344-368; add `dirname` import if absent)
- Test: `test/multi-turn-delegate.test.js`

- [ ] **Step 1: Write the failing test** — append to `test/multi-turn-delegate.test.js`. The label store is keyed by its first arg; assert the `from:<caller>` label is readable via `readLabels(meshRoot)` (returns `{ [id]: name }`) and absent from `readLabels(root)`:

```js
import { readLabels } from '../src/dashboard/session-index.js';

test('peer-session label is keyed by mesh root, not agent root (shows as from:<caller>)', async () => {
  // C = a peer agent inside a mesh; bridge env carries AGENT_MESH_MESH_CEILING = meshRoot.
  const meshRoot = await mkdtemp(join(tmpdir(), 'prov-mesh-'));
  const root = join(meshRoot, 'knowledge');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'AGENT.md'), '# Knowledge\n', 'utf8');

  const fc = await fakeClaude(`console.log('ok');`);            // helper already in this file
  const env = { AGENT_MESH_CLAUDE: fc, AGENT_MESH_TEST_PLATFORM: 'linux',
    AGENT_MESH_MESH_CEILING: meshRoot, AGENT_MESH_PROJECTS_DIR: join(meshRoot, '.projects') };

  await sendOnce({ root, env, caller: 'data-analyst' });        // helper already in this file (one ask turn)

  const meshLabels = await readLabels(meshRoot);
  assert.ok(Object.values(meshLabels).includes('from:data-analyst'), 'label under the mesh-root store');
  const agentLabels = await readLabels(root);
  assert.equal(Object.values(agentLabels).includes('from:data-analyst'), false, 'NOT under the agent-root store');
});
```

> `sendOnce`/`fakeClaude` already forward an arbitrary `env`; ensure the test passes `AGENT_MESH_MESH_CEILING` (above). The label is written inside `deriveCallerSession`, which runs for any `ask` turn.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/multi-turn-delegate.test.js`
Expected: FAIL — the label is written under `root` (agent root), so it appears in `listSessions(root)` and is absent from `listSessions(meshRoot)`.

- [ ] **Step 3: Implement in `src/a2a/stdio-server.js`** — ensure `dirname` is imported from `node:path`, then change the naming block in `deriveCallerSession` (lines 361-367):

```js
  // Best-effort dashboard naming (§3.1, §7): the label/event STORE is keyed by the
  // mesh root (what the dashboard reads), with agentRoot identifying the owning
  // agent. Fall back to the agent root only for a standalone peer (no mesh env).
  const meshRoot = env?.AGENT_MESH_MESH_CEILING
    || (env?.AGENT_MESH_MESH_ROOT ? dirname(env.AGENT_MESH_MESH_ROOT) : null);
  const labelRoot = meshRoot || root;
  try {
    await setLabel(labelRoot, id, `from:${caller}`);
    await recordEvent(labelRoot, { kind: 'create', source: `peer:${caller}`, sessionId: id, agentRoot: root });
  } catch { /* ignore — naming is cosmetic */ }
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/multi-turn-delegate.test.js`
Expected: PASS — plus the existing multi-turn tests stay green (session id/resume logic is untouched; only the label store key changed).

- [ ] **Step 5: Commit**

```bash
git add src/a2a/stdio-server.js test/multi-turn-delegate.test.js
git commit -m "fix(a2a): key peer-session labels/events by mesh root so they show as from:<caller>"
```

---

## Final verification

- [ ] **Run the affected suites + a sequential full pass:**

Run: `node --test test/peer-bridge.test.js test/dashboard-activity.test.js test/multi-turn-delegate.test.js`
Then: `node --test --test-concurrency=1`
Expected: the new tests pass; the only failures are the pre-existing Windows-platform ones (symlink `EPERM`, SIGKILL timing) — no NEW failures.

- [ ] **(Optional) live check:** if `claude` is available, `node scripts/live-a2a-check.mjs` still passes (a real two-turn ask) — and an `a2a-*.jsonl` now exists under the caller folder. Note the live harness uses a throwaway folder outside a mesh, so `from` resolves to `null` and the record still logs (caller_identity is mesh-only); that's expected.

---

## Notes for the implementer

- **Failure is data:** logging is best-effort — an a2a append failure is swallowed/`stderr`-noted and never changes `delegateToPeer`'s return value or throws into the call path.
- **No-leak invariant:** `child_log_path` / `child_run_id` / `summary_preview` live ONLY in the on-disk `a2a-*.jsonl`. `buildActivity` emits only whitelisted fields; never add these to the view-model. The Task 2 no-leak test guards this.
- **Don't re-key the session id or transcript by mesh root** — only the *label/event store* key changes in Task 4. The session id and `transcriptExists` lookup stay keyed by the peer's own `root` (the transcript is the peer's).
- **child_run_id is free:** `agentmesh/run_id` is already emitted in Task metadata (`protocol.js:74`); the bridge just reads `taskResult.metadata['agentmesh/run_id']`. No protocol change.
- **Gate order is load-bearing:** Task 1 keeps `delegateToPeer`'s exact refusal order and return values — only logging is added. Re-run the full `peer-bridge.test.js` to confirm.
