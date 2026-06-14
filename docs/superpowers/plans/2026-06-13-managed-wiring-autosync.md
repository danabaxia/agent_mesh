# Managed-Wiring Auto-Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the [2026-06-13 managed-wiring auto-sync spec](../specs/2026-06-13-managed-wiring-autosync-design.md): the dashboard process auto-runs `doctor` in a new Managed-only mode (registry.json + peer-bridge .mcp.json only) on startup and on a debounced watcher change, keeping wiring current after code updates / new agents without a manual `doctor --apply`.

**Architecture:** A `managedOnly` option gates `doctor`'s per-agent loop to its two Managed writers, which now write atomically (temp+rename) so a concurrent `claude` launch never reads a torn config. A pure, debounced, serialized coordinator (`src/dashboard/auto-sync.js`) drives the apply; the SSE hub gains a change-hook + a `sync` event; the server constructs the coordinator (unless opted out), runs it at startup, and triggers it from the watcher. A toast surfaces results.

**Tech Stack:** Node ≥ 20, zero deps, `node --test`. CI gate (ubuntu+windows × node 20/22) must stay green.

**Branch:** `claude/dreamy-goodall-vcvash`; after each task's commit the controller pushes to it AND `v0.4-development`.

**Environment baseline:** this sandbox shows 4 pre-existing `change-detect.test.js` failures (git-signing proxy artifact — passes on GitHub CI). "Suite green" locally = exactly those 4 red, nothing else.

---

## File structure

| File | Responsibility |
|---|---|
| `src/builder/doctor.js` | + `managedOnly` option (gate to registry+bridge); two Managed writers → atomic |
| `src/atomic-write.js` | reused as-is (`atomicWriteFile(path, content, {mode})`) |
| `src/dashboard/auto-sync.js` (new) | pure debounced/serialized coordinator |
| `src/dashboard/server.js` | SSE-hub change-hook + `emitSync`; construct coordinator; startup run; opt-out; close |
| `src/config.js` | `DEFAULT_AUTOSYNC_DEBOUNCE_MS` |
| `src/dashboard/public/app.js` + `board2.js` | `sync` SSE handler → toast |
| `CLAUDE.md` / `PROJECT.md` | config line + changelog |

---

### Task 1: `doctor` Managed-only mode + atomic Managed writes

**Files:**
- Modify: `src/builder/doctor.js` (signature ~:49, loop ~:64-86, writes :126 + :193)
- Test: `test/doctor.test.js` (extend)

- [ ] **Step 1: Read the current loop + write sites**

Read `src/builder/doctor.js`: the `doctor(meshRoot, { agentName, apply = false })` signature (~:49); the per-agent loop calling `fixRegistry` (step 1), `seedMissingAnatomy` (step 2), `proposeSeededFixes` (step 3), `syncBridgeMcp` (step 4); the two `writeFile(...)` Managed write sites — `syncBridgeMcp` at :126 and `fixRegistry` at :193 (both `writeFile(path, JSON.stringify(...) + '\n', 'utf8')`).

- [ ] **Step 2: Write the failing tests**

Append to `test/doctor.test.js` (reuse its existing mesh fixture builder — find how its other tests construct a mesh with a marker'd registry + a Seeded gap; mirror that):

```js
test('doctor managedOnly: applies registry+bridge only, skips seed/propose, idempotent', async () => {
  // Build a mesh where: agentA has peers (so registry+bridge drift) AND a missing
  // prompts/system.md (a Seeded gap). Use this file's existing fixture helper.
  const { meshRoot } = await buildDriftMesh(); // ← adapt to the file's real helper name
  const r = await doctor(meshRoot, { apply: true, managedOnly: true });
  // Managed wiring applied:
  assert.ok(r.fixed.some((s) => /registry\.json|peer-bridge/.test(s)));
  // Seeded/Authored untouched in managedOnly:
  assert.deepEqual(r.seeded, []);
  assert.deepEqual(r.proposed, []);
  // The Seeded gap file was NOT created:
  await assert.rejects(() => access(join(meshRoot, 'agentA', 'prompts', 'system.md')));
  // Idempotent: a second managedOnly apply changes nothing:
  const r2 = await doctor(meshRoot, { apply: true, managedOnly: true });
  assert.deepEqual(r2.fixed, []);
});

test('doctor managedOnly:false unchanged from today (regression)', async () => {
  const { meshRoot } = await buildDriftMesh();
  const full = await doctor(meshRoot, { apply: false }); // dry-run, default mode
  // seed/propose still reported in full mode (the Seeded gap surfaces):
  assert.ok(full.seeded.length > 0 || full.proposed.length > 0 || full.flagged.length > 0);
});
```

(Adapt `buildDriftMesh`/`access`/`join` to the file's real helpers + imports. If the file lacks a drift fixture, build one inline with `mkdtemp` + write a `mesh.json` with two peered agents and a marker'd `registry.json` whose peers differ — match the patterns in `test/doctor-bridge.test.js`, which already builds peered agents.)

- [ ] **Step 3: Run to verify they fail**

Run: `node --test test/doctor.test.js` — the managedOnly test FAILS (`managedOnly` ignored → seeds the gap / `seeded` non-empty).

- [ ] **Step 4: Implement managedOnly gate**

In `src/builder/doctor.js` change the signature:

```js
export async function doctor(meshRoot, { agentName, apply = false, managedOnly = false } = {}) {
```

In the per-agent loop, gate steps 2 and 3:

```js
  for (const agent of snapshot.agents) {
    await fixRegistry(agent, manifest, meshRoot, apply, fixed, flagged);   // Managed
    if (!managedOnly) {
      await seedMissingAnatomy(agent, apply, seeded, flagged);             // Seeded create
      await proposeSeededFixes(agent, apply, proposed, flagged);           // Seeded propose
    }
    await syncBridgeMcp(agent, apply, fixed, flagged);                     // Managed
  }
```

- [ ] **Step 5: Make the two Managed writers atomic**

Add the import near the top of `src/builder/doctor.js`:

```js
import { atomicWriteFile } from '../atomic-write.js';
```

Replace the `syncBridgeMcp` write (:126):

```js
  // Atomic (temp+rename): a claude session launching mid-sync reads old-or-new,
  // never a torn .mcp.json. mode 0o644 preserves config readability (writeFile's
  // prior default), not atomicWriteFile's 0o600 secret-file default.
  await atomicWriteFile(mcpPath, JSON.stringify(next, null, 2) + '\n', { mode: 0o644 });
```

Replace the `fixRegistry` write (:193):

```js
  await atomicWriteFile(registryPath, JSON.stringify(registry, null, 2) + '\n', { mode: 0o644 });
```

(Leave `seedMissingAnatomy`'s `writeFile` at :262 unchanged — out of scope.)

- [ ] **Step 6: Run tests**

Run: `node --test test/doctor.test.js test/doctor-bridge.test.js test/conformance.test.js test/add.test.js test/leave-join-propose.test.js test/mesh-health.test.js` — all green (mesh-health's `check_conformance` calls `doctor({apply:false})` default mode — unaffected). Then `node run-all-tests.mjs` → only the 4 change-detect baseline reds.

- [ ] **Step 7: Commit**

```bash
git add src/builder/doctor.js test/doctor.test.js
git commit -m "feat(doctor): managedOnly mode + atomic Managed writes (registry + bridge)"
```

---

### Task 2: Auto-sync coordinator (pure)

**Files:**
- Create: `src/dashboard/auto-sync.js`
- Test: `test/auto-sync.test.js` (new)

- [ ] **Step 1: Write the failing tests**

Create `test/auto-sync.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoSync } from '../src/dashboard/auto-sync.js';

// Controllable schedule seam: capture the pending timer fn; fire() runs it.
function fakeSchedule() {
  let pending = null;
  const schedule = (fn) => { pending = fn; return { id: 1 }; };
  const clearSchedule = () => { pending = null; };
  return { schedule, clearSchedule, fire: async () => { const fn = pending; pending = null; if (fn) await fn(); }, get armed() { return pending !== null; } };
}

test('debounce: many triggers collapse to ONE run', async () => {
  const t = fakeSchedule();
  const calls = [];
  const mgr = createAutoSync({ runSync: async () => { calls.push(1); return { fixed: ['x'] }; },
    schedule: t.schedule, clearSchedule: t.clearSchedule, debounceMs: 5, onResult: () => {}, log: () => {} });
  mgr.trigger(); mgr.trigger(); mgr.trigger();
  await t.fire();
  assert.equal(calls.length, 1);
});

test('onResult fires with the result; serialized rerun when triggered mid-run', async () => {
  const t = fakeSchedule();
  let release; const gate = new Promise((r) => { release = r; });
  const results = [];
  let n = 0;
  const mgr = createAutoSync({
    runSync: async () => { n++; if (n === 1) await gate; return { fixed: [`run${n}`] }; },
    schedule: t.schedule, clearSchedule: t.clearSchedule, debounceMs: 5,
    onResult: (r) => results.push(r), log: () => {}
  });
  mgr.trigger();
  const fired = t.fire();           // starts run 1 (awaits gate)
  mgr.trigger();                    // lands mid-run → sets pendingRerun, no new timer
  release();
  await fired;                      // run 1 completes → pendingRerun drives run 2
  assert.equal(t.armed, false);     // mid-run trigger did NOT arm a redundant timer
  assert.deepEqual(results.map((r) => r.result.fixed[0]), ['run1', 'run2']);
});

test('runNow bypasses debounce and runs immediately', async () => {
  const t = fakeSchedule();
  const calls = [];
  const mgr = createAutoSync({ runSync: async () => { calls.push(1); return { fixed: [] }; },
    schedule: t.schedule, clearSchedule: t.clearSchedule, debounceMs: 5, onResult: () => {}, log: () => {} });
  await mgr.runNow();
  assert.equal(calls.length, 1);
  assert.equal(t.armed, false); // did not use the debounce timer
});

test('runSync rejection → onResult {ok:false, error}; never throws', async () => {
  const t = fakeSchedule();
  const results = [];
  const mgr = createAutoSync({ runSync: async () => { throw new Error('boom'); },
    schedule: t.schedule, clearSchedule: t.clearSchedule, debounceMs: 5, onResult: (r) => results.push(r), log: () => {} });
  await mgr.runNow();
  assert.equal(results[0].ok, false);
  assert.match(results[0].error.message, /boom/);
});

test('stop cancels a pending fire', async () => {
  const t = fakeSchedule();
  const calls = [];
  const mgr = createAutoSync({ runSync: async () => { calls.push(1); return { fixed: [] }; },
    schedule: t.schedule, clearSchedule: t.clearSchedule, debounceMs: 5, onResult: () => {}, log: () => {} });
  mgr.trigger();
  mgr.stop();
  await t.fire(); // the captured fn should no-op after stop
  assert.equal(calls.length, 0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/auto-sync.test.js` — FAIL (module missing).

- [ ] **Step 3: Implement**

Create `src/dashboard/auto-sync.js`:

```js
/**
 * src/dashboard/auto-sync.js — PURE-ish coordinator for managed-wiring auto-sync
 * (2026-06-13 spec §4). Debounce-coalesces triggers, serializes runs (one
 * in-flight; a trigger arriving mid-run schedules exactly ONE coalesced rerun),
 * and reports every completed run via onResult({ ok, result?, error? }). The
 * emit-only-on-change filter lives in the SERVER's onResult (checks
 * result.fixed.length), so this stays generic. Never throws.
 */
export function createAutoSync({ runSync, schedule = setTimeout, clearSchedule = clearTimeout, debounceMs, onResult, log = () => {} }) {
  let timer = null;
  let running = false;
  let pendingRerun = false;
  let stopped = false;

  async function execute() {
    if (stopped) return;
    if (running) { pendingRerun = true; return; }   // backstop: runNow racing a run
    running = true;
    let report;
    try { report = { ok: true, result: await runSync() }; }
    catch (error) { report = { ok: false, error }; log(`auto-sync failed: ${error?.message}`); }
    running = false;
    try { onResult(report); } catch { /* observer must not break the loop */ }
    if (pendingRerun && !stopped) { pendingRerun = false; await execute(); }
  }

  function trigger() {
    if (stopped) return;
    // Mid-run: coalesce into ONE rerun via the flag — do NOT also arm a timer
    // (that would double-run: pendingRerun fires it AND the timer fires it).
    if (running) { pendingRerun = true; return; }
    if (timer) clearSchedule(timer);
    timer = schedule(() => { timer = null; execute().catch(() => {}); }, debounceMs);
    timer?.unref?.();
  }

  async function runNow() {
    if (stopped) return;
    await execute();
  }

  function stop() {
    stopped = true;
    if (timer) { try { clearSchedule(timer); } catch { /* fake timers */ } timer = null; }
  }

  return { trigger, runNow, stop };
}
```

NOTE the mid-run test: run 1 is awaiting the gate when `trigger()` fires → `execute()` sees `running` → sets `pendingRerun`. After run 1's `onResult`, `pendingRerun` drives run 2. `trigger()` arms the debounce timer too, but the test fires `execute` directly via the coalesced path; the extra armed timer is harmless (the test's second `t.fire()` covers it, and a real timer would just find nothing to do or coalesce). Verify all 5 tests pass; if the mid-run ordering differs, the TESTS are the contract — adjust the implementation.

- [ ] **Step 4: Run tests, commit**

Run: `node --test test/auto-sync.test.js` → 5/5.

```bash
git add src/dashboard/auto-sync.js test/auto-sync.test.js
git commit -m "feat(autosync): debounced serialized coordinator (pure, injected seams)"
```

---

### Task 3: SSE hub change-hook + `emitSync`

**Files:**
- Modify: `src/dashboard/server.js` `createSseHub` (~:2422-2500)
- Test: `test/dashboard-watcher.test.js` or `test/dashboard-server.test.js` (extend — whichever exercises createSseHub; if neither does directly, add a focused test in a new `test/sse-sync.test.js`)

- [ ] **Step 1: Write the failing test**

`createSseHub` is module-internal (not exported). Export it for testing: add `export` to `function createSseHub` (it stays used internally too). Create `test/sse-sync.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSseHub } from '../src/dashboard/server.js';

// A fake SSE client res that records written frames.
function fakeRes() { const frames = []; return { writeHead() {}, write(s) { frames.push(s); }, end() {}, on() {}, frames }; }

test('emitSync writes a `sync` event frame to connected clients', async () => {
  const hub = createSseHub({ meshRoot: '/nope', pollMs: 100000, onMeshChange: () => {} });
  const res = fakeRes();
  // addClient establishes the watcher baseline then registers the client; with a
  // bogus meshRoot the watcher scan is empty/harmless. Register the client:
  await hub.addClient({ on() {} }, res);
  hub.emitSync({ synced: ['coder'], at: 123 });
  const frame = res.frames.find((f) => f.startsWith('event: sync'));
  assert.ok(frame, 'a sync frame was written');
  assert.match(frame, /"synced":\["coder"\]/);
  hub.close();
});
```

(If `addClient` with a bogus meshRoot hangs on `ensureWatcher`, point `meshRoot` at a real empty `mkdtemp` dir instead, and pass `pollMs` large so no real poll fires. Adapt the fake `req`/`res` to whatever `addClient` actually calls — read it first.)

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/sse-sync.test.js` — FAIL (`createSseHub` not exported / `emitSync`/`onMeshChange` absent).

- [ ] **Step 3: Implement**

In `src/dashboard/server.js`:

1. `export function createSseHub({ meshRoot, pollMs, onMeshChange = () => {} }) {`

2. In `onWatcherChange`, after the existing `emit('change')`/`activity`, call the hook (guarded — a sync trigger must never break the change stream):

```js
  async function onWatcherChange(evt) {
    emit('change', evt);
    try { emit('activity', await loadActivitySnapshot(meshRoot)); } catch { /* transient */ }
    try { onMeshChange(); } catch { /* auto-sync trigger must not break the SSE stream */ }
  }
```

3. Add `emitSync` to the returned object:

```js
  return { addClient, close, emitSync: (data) => emit('sync', data) };
```

- [ ] **Step 4: Run tests**

Run: `node --test test/sse-sync.test.js test/dashboard-server.test.js test/dashboard-watcher.test.js` → green.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/server.js test/sse-sync.test.js
git commit -m "feat(sse): mesh-change hook + emitSync on the dashboard event hub"
```

---

### Task 4: Server wiring — construct coordinator, startup run, opt-out, close

**Files:**
- Modify: `src/config.js` (constant), `src/dashboard/server.js` (`createDashboardServer` ~:2516, its `sse` construction, `start()`, `close()`)
- Test: `test/dashboard-server.test.js` (extend)

- [ ] **Step 1: Config constant**

In `src/config.js`, after the session-generations knobs:

```js
// Managed-wiring auto-sync (spec 2026-06-13): debounce window for watcher-driven
// doctor managedOnly applies. AGENT_MESH_NO_AUTOSYNC=1 disables auto-sync.
export const DEFAULT_AUTOSYNC_DEBOUNCE_MS = 2000;
```

- [ ] **Step 2: Write the failing test**

In `test/dashboard-server.test.js`, mirror its existing `createDashboardServer({...})` harness. The new contract: `createDashboardServer` accepts an injectable `runSync`; when enabled, `start()` invokes it once (startup sync); `AGENT_MESH_NO_AUTOSYNC=1` suppresses it.

```js
test('auto-sync: startup runs the managed sync once; opt-out env suppresses it', async (t) => {
  const calls = [];
  const runSync = async () => { calls.push(1); return { fixed: [] }; };
  // ENABLED:
  const srv = createDashboardServer({ meshRoot, token: 'tok', runSync }); // adapt to harness
  await srv.start();
  await new Promise((r) => setTimeout(r, 20)); // startup runNow is fire-and-forget
  assert.equal(calls.length, 1);
  await srv.close();
  // OPT-OUT:
  const prev = process.env.AGENT_MESH_NO_AUTOSYNC; process.env.AGENT_MESH_NO_AUTOSYNC = '1';
  try {
    const calls2 = [];
    const srv2 = createDashboardServer({ meshRoot, token: 'tok', runSync: async () => { calls2.push(1); return { fixed: [] }; } });
    await srv2.start(); await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls2.length, 0);
    await srv2.close();
  } finally { if (prev === undefined) delete process.env.AGENT_MESH_NO_AUTOSYNC; else process.env.AGENT_MESH_NO_AUTOSYNC = prev; }
});
```

(Adapt `meshRoot` setup + `createDashboardServer` option names to the harness. If `start()` binds a port, reuse the harness's port handling. The key asserts: startup invokes `runSync` once when enabled, zero when opted out.)

- [ ] **Step 3: Run to verify it fails**

Run: `node --test test/dashboard-server.test.js` — new test FAILS (`runSync` ignored).

- [ ] **Step 4: Implement the wiring**

In `src/dashboard/server.js`:

1. Imports: `import { createAutoSync } from './auto-sync.js';`, `import { doctor } from '../builder/doctor.js';`, and add `DEFAULT_AUTOSYNC_DEBOUNCE_MS` + `readPositiveInt` to the config import.

2. `createDashboardServer` options gain `runSync` (default undefined):

```js
export function createDashboardServer({ meshRoot, port = 7077, token, consoleBroker, watchPollMs = 1000, allowShell = false, chat = false, shellLauncher, sessionRunner, sessionIndex, sessionMirror, sessionLive, imgFetcher, spawnLocate, scheduler, rotation, runSync }) {
```

3. Construct the coordinator + wire the SSE hub. Find where `const sse = createSseHub({ meshRoot, pollMs: watchPollMs });` is and replace with:

```js
  const autoSyncEnabled = process.env.AGENT_MESH_NO_AUTOSYNC !== '1';
  let autoSync = null;
  const sse = createSseHub({ meshRoot, pollMs: watchPollMs, onMeshChange: () => autoSync?.trigger() });
  if (autoSyncEnabled) {
    autoSync = createAutoSync({
      runSync: runSync ?? (() => doctor(meshRoot, { apply: true, managedOnly: true })),
      debounceMs: readPositiveInt(process.env.AGENT_MESH_AUTOSYNC_DEBOUNCE_MS, DEFAULT_AUTOSYNC_DEBOUNCE_MS),
      // emit-only-on-change lives here: only push a sync event when wiring changed.
      onResult: (r) => {
        if (r.ok === false) { sse.emitSync({ ok: false, error: String(r.error?.code || r.error?.message || r.error), at: Date.now() }); return; }
        if (r.result?.fixed?.length) sse.emitSync({ synced: r.result.fixed, at: Date.now() });
      },
      log: (line) => process.stderr.write(`[agent-mesh] ${line}\n`)
    });
  }
```

(`onMeshChange: () => autoSync?.trigger()` closes over the `let autoSync` binding and reads it at call time — assigned just below, like the rotation-manager wiring.)

4. In `start()`, after the server is listening, kick the startup sync **without awaiting** (don't delay readiness):

```js
    if (autoSync) autoSync.runNow().catch(() => {});
```

5. In `close()`, stop it: `autoSync?.stop();` (alongside the existing `sse.close()`).

- [ ] **Step 5: Run tests**

Run: `node --test test/dashboard-server.test.js test/sse-sync.test.js test/auto-sync.test.js` → green. Then `node run-all-tests.mjs` → 4 change-detect baseline reds only.

- [ ] **Step 6: Commit**

```bash
git add src/config.js src/dashboard/server.js test/dashboard-server.test.js
git commit -m "feat(dashboard): construct managed auto-sync — startup run, watcher trigger, opt-out"
```

---

### Task 5: UI — toast on the `sync` event

**Files:**
- Modify: `src/dashboard/public/app.js` (~:2054 EventSource) and `src/dashboard/public/board2.js` (~:361 EventSource)
- Test: none automated (frontend SSE handler; verified by `node --check` + the existing frontend suites staying green)

- [ ] **Step 1: Read the existing SSE handlers**

Read `app.js:2052-2066` and `board2.js:359-363` — how `es.addEventListener('change'|'activity', …)` is wired, and what toast/flash affordance each file already has (grep `flash`/`toast` in each).

- [ ] **Step 2: Add the `sync` handler in app.js**

After the existing `es.addEventListener('activity', …)` in `app.js` (~:2057):

```js
    es.addEventListener('sync', (e) => {
      let d; try { d = JSON.parse(e.data); } catch { return; }
      if (d.ok === false) { toast(`Auto-sync failed (${d.error || 'unknown'}) — run \`agent-mesh doctor\``); return; }
      if (Array.isArray(d.synced) && d.synced.length) toast(`Wiring synced: ${d.synced.length} change(s)`);
    });
```

(Use the file's actual toast/flash function name — if it's `flash` or `showToast`, use that; if there is none, append a transient `<div>` to the body and remove it after 4s. Keep it one small function; match the file's idiom.)

- [ ] **Step 3: Add the same handler in board2.js**

After board2.js's `es.addEventListener('activity', …)` (~:362), add the same `es.addEventListener('sync', …)` block, using board2's toast/flash idiom (read it first).

- [ ] **Step 4: Verify**

Run: `node --check src/dashboard/public/app.js && node --check src/dashboard/public/board2.js`. Then `node --test test/dashboard-server.test.js test/session-log-frontend.test.js` → green (no frontend regression). `node run-all-tests.mjs` → baseline.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/public/app.js src/dashboard/public/board2.js
git commit -m "feat(dashboard-ui): toast on managed-wiring sync events"
```

---

### Task 6: Docs + final verification

**Files:**
- Modify: `CLAUDE.md`, `PROJECT.md`, spec §12

- [ ] **Step 1: CLAUDE.md config line**

In CLAUDE.md's "Config (env, all optional)" list, append (matching the `·`-separated style):

```
`AGENT_MESH_NO_AUTOSYNC` (unset; set to `1` to disable the dashboard's managed-wiring auto-sync) · `AGENT_MESH_AUTOSYNC_DEBOUNCE_MS` (2000)
```

- [ ] **Step 2: PROJECT.md changelog**

Add at the top of the changelog list (match existing style):

`2026-06-13 — managed-wiring auto-sync: the dashboard auto-runs doctor in a new Managed-only mode (registry.json + peer-bridge .mcp.json only) on startup and on a debounced watcher change, keeping wiring current after code updates / new agents; atomic config writes; Seeded/Authored stay propose-only; framework applies, never an agent. Spec: docs/superpowers/specs/2026-06-13-managed-wiring-autosync-design.md.`

- [ ] **Step 3: Spec §12 note**

Replace the pending bullet in the spec's §12 with: implementation landed on `claude/dreamy-goodall-vcvash` per `docs/superpowers/plans/2026-06-13-managed-wiring-autosync.md`; suite green at the documented baseline.

- [ ] **Step 4: Full suite + commit**

Run: `node run-all-tests.mjs` → exactly the 4 change-detect baseline reds. Report counts.

```bash
git add CLAUDE.md PROJECT.md docs/superpowers/specs/2026-06-13-managed-wiring-autosync-design.md
git commit -m "docs: managed-wiring auto-sync — config, changelog, spec note"
```

---

## Self-review checklist (run after Task 6)

- Spec §3→T1, §4→T2, §5(atomic)→T1, §6/§7(SSE)→T3+T4, opt-out/startup/debounce→T4, UI→T5, docs→T6. §10 test items 1→T1, 2→T2, 3→T3+T4, 4→T1(atomic). All mapped.
- Grep the diff for any new `spawn(` (must be none) and confirm `contract.js`/`path-guard.js` are untouched (`git diff` those paths empty).
- The deprecated/default `doctor` callers (CLI, mesh-health) still pass no `managedOnly` → unchanged behavior.
- CI green on all four matrix jobs before calling it done.
