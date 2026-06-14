# Mesh-Manager Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `mesh-manager` agent to the live mesh (`my-mesh/`) backed by a new read-only `mesh-health` MCP server (conformance dry-run, A2A liveness ping, run-log triage) and a daily scheduled health sweep that writes a report deliverable.

**Architecture:** One new framework component — `src/mesh-health/` (a pure-ish core + thin stdio MCP wrapper, modeled exactly on `src/a2a/peer-bridge.js`) exposed via a hidden CLI verb `serve-mesh-health` and registered in `my-mesh/mesh/mcp.json` with the `x-agentmesh readOnly` marker so ask-mode delegations get it. The agent itself is pure content created with the existing builder (`agent-mesh add`), wired as a peer of all five existing agents, with a daily `schedule.json` job whose `saveArtifact:true` persists the report. The agent observes and proposes; it never mutates the mesh.

**Tech Stack:** Node >= 20, zero deps, `node --test`. Spec: `docs/superpowers/specs/2026-06-11-mesh-manager-agent-design.md`.

---

## File structure

| File | Action | Responsibility |
|---|---|---|
| `src/mesh-health/core.js` | Create | The three verbs as plain async functions; failures returned as data, never thrown |
| `src/mesh-health/server.js` | Create | Stdio MCP wrapper: initialize/ping/tools/list/tools/call over `StdioTransport` |
| `src/cli.js` | Modify | Hidden verb `serve-mesh-health [mesh-root]` (lazy import, like `serve-peer-bridge`) |
| `test/mesh-health.test.js` | Create | Hermetic tests for all verbs + the stdio wire |
| `my-mesh/mesh/mcp.json` | Modify (live mesh, NOT in git) | Register `mesh-health` with `readOnly: true` |
| `my-mesh/mesh.json` | Modify (live mesh, NOT in git) | `mesh-manager` entry + peer wiring |
| `my-mesh/mesh-manager/*` | Create via builder (NOT in git) | Agent content: AGENT.md, CLAUDE.md, skill, schedule.json |

Repo commits cover `src/`, `test/`, `docs/` only — `my-mesh/` is untracked live-mesh state (verify with `git check-ignore my-mesh` / absence from `git ls-files`; its `mesh/mcp.json` holds credentials and must never be committed).

**Conventions you must follow (from CLAUDE.md):**
- Never `spawn('claude'…)` raw; this plan only spawns `process.execPath` (node itself), which is safe on Windows.
- Failure is data: every verb resolves to an object, never rejects.
- Worker-facing prompts phrase capabilities FUNCTIONALLY, never by MCP tool name (first-turn tool-registration race).
- Never name an MCP server `agentmesh_*` (reserved, silently dropped).

---

### Task 1: `triage_logs` core verb

**Files:**
- Create: `src/mesh-health/core.js`
- Create: `test/mesh-health.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/mesh-health.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMeshHealth } from '../src/mesh-health/core.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

async function makeMesh(t, agents = [{ name: 'alpha', root: './alpha' }]) {
  const meshRoot = await mkdtemp(join(tmpdir(), 'mesh-health-'));
  t.after(() => rm(meshRoot, { recursive: true, force: true }));
  await writeFile(join(meshRoot, 'mesh.json'), JSON.stringify({
    'x-agentmesh-generated': true,
    meshVersion: '0.1.0',
    agents: agents.map((a) => ({
      name: a.name, root: a.root, card: 'agent.json',
      served: a.served ?? true, enabledModes: ['ask'], peers: []
    }))
  }, null, 2));
  for (const a of agents) {
    const dir = join(meshRoot, a.root);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'AGENT.md'), `# ${a.name}\n\nTest agent.\n`);
  }
  return meshRoot;
}

function logLine(rec) { return JSON.stringify(rec) + '\n'; }

// ---------------------------------------------------------------------------
// triage_logs
// ---------------------------------------------------------------------------

test('triage_logs counts failures and reads schedule state', async (t) => {
  const meshRoot = await makeMesh(t);
  const logDir = join(meshRoot, 'alpha', '.agent-mesh', 'logs');
  await mkdir(logDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();
  await writeFile(join(logDir, `delegate-${today}.jsonl`),
    logLine({ id: 'r1', state: 'started', started_at: now, mode: 'ask' }) +
    logLine({ id: 'r1', state: 'done', started_at: now, finished_at: now, status: 'done', summary: 'ok' }) +
    logLine({ id: 'r2', state: 'started', started_at: now, mode: 'ask' }) +
    logLine({ id: 'r2', state: 'done', started_at: now, finished_at: now, status: 'timeout' }) +
    logLine({ id: 'r3', state: 'started', started_at: now, mode: 'ask' }));
  await writeFile(join(meshRoot, 'alpha', '.agent-mesh', 'schedule-state.json'), JSON.stringify({
    'job-1': { lastRunAt: now, lastStatus: 'fail', lastSummary: 'boom', nextRunAt: now, running: false }
  }));

  const health = createMeshHealth({ meshRoot });
  const out = await health.triageLogs({ since_hours: 24 });

  assert.equal(out.error, undefined);
  assert.equal(out.agents.length, 1);
  const alpha = out.agents[0];
  assert.equal(alpha.name, 'alpha');
  assert.equal(alpha.runs, 2);              // two FINAL records
  assert.equal(alpha.failures, 1);          // the timeout
  assert.equal(alpha.in_flight, 1);         // r3 never finished
  assert.equal(alpha.recent_failures.length, 1);
  assert.equal(alpha.recent_failures[0].status, 'timeout');
  assert.ok(alpha.recent_failures[0].log_file.endsWith('.jsonl'));
  assert.equal(alpha.schedule.length, 1);
  assert.equal(alpha.schedule[0].last_status, 'fail');
});

test('triage_logs tolerates missing logs dir and missing schedule state', async (t) => {
  const meshRoot = await makeMesh(t);
  const health = createMeshHealth({ meshRoot });
  const out = await health.triageLogs({});
  assert.equal(out.agents.length, 1);
  assert.equal(out.agents[0].runs, 0);
  assert.equal(out.agents[0].failures, 0);
  assert.deepEqual(out.agents[0].schedule, []);
});

test('triage_logs unknown agent filter returns error data', async (t) => {
  const meshRoot = await makeMesh(t);
  const health = createMeshHealth({ meshRoot });
  const out = await health.triageLogs({ agent: 'nope' });
  assert.equal(out.error, 'unknown_agent');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/mesh-health.test.js`
Expected: FAIL — `Cannot find module '../src/mesh-health/core.js'`

- [ ] **Step 3: Implement the core with `triageLogs`**

Create `src/mesh-health/core.js`:

```js
/**
 * src/mesh-health/core.js — mesh-health verbs (core, no stdio).
 *
 * Read-only health checks over ONE mesh root, exposed to the mesh-manager
 * agent through the mesh-health MCP server (spec
 * docs/superpowers/specs/2026-06-11-mesh-manager-agent-design.md).
 *
 * Every verb resolves to a plain data object — failure is data, never a
 * thrown exception. Agent names are validated against the manifest; the
 * model can never pass a filesystem path.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { loadSnapshot, checkConformance as runConformance } from '../builder/conformance.js';
import { doctor } from '../builder/doctor.js';
import { readManifest } from '../builder/manifest.js';
import { readRunLogRecords, dedupeRunRecords } from '../log.js';
import { killProcessTree } from '../process.js';

const BIN_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../bin/agent-mesh.js');
const DEFAULT_PING_TIMEOUT_MS = 10_000;
const MAX_RECENT_FAILURES = 10;
// delegate logs use 'done'; a2a bridge logs use 'completed' — both are success.
const OK_STATUSES = new Set(['done', 'completed']);

function readPositiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function createMeshHealth({ meshRoot, env = process.env, binPath = BIN_PATH } = {}) {
  const pingTimeoutMs = readPositiveInt(env.AGENT_MESH_HEALTH_PING_TIMEOUT_MS, DEFAULT_PING_TIMEOUT_MS);

  async function triageLogs({ agent, since_hours = 24 } = {}) {
    let manifest;
    try {
      manifest = await readManifest(meshRoot);
    } catch (err) {
      return { error: `manifest_unreadable: ${err.message}` };
    }
    const entries = (manifest.agents || []).filter((a) => !agent || a.name === agent);
    if (agent && entries.length === 0) return { error: 'unknown_agent' };

    const cutoff = Date.now() - since_hours * 3_600_000;
    const agents = [];
    for (const entry of entries) {
      const agentRoot = resolve(meshRoot, entry.root);
      const logDir = join(agentRoot, '.agent-mesh', 'logs');

      let files = [];
      try {
        files = (await readdir(logDir)).filter((f) => f.endsWith('.jsonl'));
      } catch { /* no logs yet — healthy emptiness */ }

      // Files are grouped by START date (<prefix>-YYYY-MM-DD.jsonl); skip any
      // whose entire day ends before the window starts.
      const records = [];
      for (const f of files) {
        const m = f.match(/(\d{4}-\d{2}-\d{2})\.jsonl$/);
        if (!m || new Date(`${m[1]}T23:59:59.999Z`).getTime() < cutoff) continue;
        const path = join(logDir, f);
        for (const r of dedupeRunRecords(await readRunLogRecords(path))) {
          records.push({ ...r, log_file: path });
        }
      }

      const recent = records.filter((r) => r.started_at && Date.parse(r.started_at) >= cutoff);
      const finals = recent.filter((r) => r.state === 'done');
      const failures = finals
        .filter((r) => typeof r.status === 'string' && !OK_STATUSES.has(r.status))
        .sort((a, b) => (b.started_at || '').localeCompare(a.started_at || ''));

      const schedule = [];
      try {
        const state = JSON.parse(await readFile(join(agentRoot, '.agent-mesh', 'schedule-state.json'), 'utf8'));
        for (const [jobId, s] of Object.entries(state)) {
          if (!s || typeof s !== 'object') continue;
          schedule.push({
            job_id: jobId,
            last_status: s.lastStatus ?? null,
            last_run_at: s.lastRunAt ?? null,
            last_summary: s.lastSummary ?? null
          });
        }
      } catch { /* absent or corrupt → empty (tolerant, like the scheduler) */ }

      agents.push({
        name: entry.name,
        runs: finals.length,
        failures: failures.length,
        in_flight: recent.filter((r) => r.state === 'started').length,
        recent_failures: failures.slice(0, MAX_RECENT_FAILURES).map((r) => ({
          id: r.id ?? null,
          status: r.status,
          error_code: r.result?.error?.code ?? r.error_code ?? null,
          route: r.route ?? null,
          started_at: r.started_at ?? null,
          log_file: r.log_file
        })),
        schedule
      });
    }
    return { since_hours, agents };
  }

  return { triageLogs };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/mesh-health.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/mesh-health/core.js test/mesh-health.test.js
git commit -m "feat(mesh-health): triage_logs verb — run-log and schedule-state failure scan"
```

---

### Task 2: `check_conformance` core verb

**Files:**
- Modify: `src/mesh-health/core.js`
- Modify: `test/mesh-health.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/mesh-health.test.js`:

```js
// ---------------------------------------------------------------------------
// check_conformance
// ---------------------------------------------------------------------------

test('check_conformance reports problems on a broken mesh, dry-run only', async (t) => {
  // makeMesh creates agents with ONLY AGENT.md — no agent.json, no prompts/ —
  // so anatomy/structure rules must fail. The verb must surface that as data.
  const meshRoot = await makeMesh(t);
  const health = createMeshHealth({ meshRoot });
  const out = await health.checkConformance();

  assert.equal(out.ok, false);
  assert.ok(out.counts.fail > 0);
  assert.ok(out.problems.length > 0);
  assert.ok(out.problems.every((p) => p.rule && p.level && p.detail));
  // doctor ran as DRY-RUN: report present, and nothing was written to disk
  assert.ok(out.doctor_dry_run);
  assert.ok(Array.isArray(out.doctor_dry_run.flagged));
  const { readdir: rd } = await import('node:fs/promises');
  const alphaFiles = await rd(join(meshRoot, 'alpha'));
  assert.deepEqual(alphaFiles.sort(), ['AGENT.md'], 'dry-run must not scaffold files');
});

test('check_conformance with unreadable mesh.json returns error data', async (t) => {
  const meshRoot = await mkdtemp(join(tmpdir(), 'mesh-health-'));
  t.after(() => rm(meshRoot, { recursive: true, force: true }));
  const health = createMeshHealth({ meshRoot });
  const out = await health.checkConformance();
  assert.equal(out.ok, false);
  assert.ok(out.error);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/mesh-health.test.js`
Expected: FAIL — `health.checkConformance is not a function`

- [ ] **Step 3: Implement `checkConformance`**

In `src/mesh-health/core.js`, add inside `createMeshHealth` (before the `return`):

```js
  async function checkConformanceVerb() {
    try {
      const snapshot = await loadSnapshot(meshRoot);
      if (snapshot.manifestError) {
        return { ok: false, error: `mesh.json unreadable: ${snapshot.manifestError}` };
      }
      const report = runConformance(snapshot);
      const dry = await doctor(meshRoot, { apply: false }); // NEVER apply here
      const counts = { pass: 0, warn: 0, fail: 0 };
      for (const r of report.rules) counts[r.level] = (counts[r.level] ?? 0) + 1;
      return {
        ok: report.ok,
        counts,
        problems: report.rules.filter((r) => r.level !== 'pass'),
        doctor_dry_run: dry // what `agent-mesh doctor --apply` WOULD do
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
```

and change the return to:

```js
  return { triageLogs, checkConformance: checkConformanceVerb };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/mesh-health.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/mesh-health/core.js test/mesh-health.test.js
git commit -m "feat(mesh-health): check_conformance verb — doctor/conformance dry-run as data"
```

---

### Task 3: `ping_agent` core verb

**Files:**
- Modify: `src/mesh-health/core.js`
- Modify: `test/mesh-health.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `test/mesh-health.test.js`:

```js
// ---------------------------------------------------------------------------
// ping_agent
// ---------------------------------------------------------------------------

test('ping_agent rejects unknown and unserved agents as data', async (t) => {
  const meshRoot = await makeMesh(t, [
    { name: 'alpha', root: './alpha' },
    { name: 'ghost', root: './ghost', served: false }
  ]);
  const health = createMeshHealth({ meshRoot });
  assert.equal((await health.pingAgent({ name: 'nope' })).error, 'unknown_agent');
  assert.equal((await health.pingAgent({ name: 'ghost' })).error, 'not_served');
  assert.equal((await health.pingAgent({})).error, 'bad_input');
});

test('ping_agent live probe: real serve-a2a answers initialize/ping', async (t) => {
  const meshRoot = await makeMesh(t);
  const health = createMeshHealth({ meshRoot });
  const out = await health.pingAgent({ name: 'alpha' });
  assert.equal(out.error, undefined);
  assert.equal(out.alive, true);
  assert.equal(typeof out.latency_ms, 'number');
});

test('ping_agent timeout: a hung server is killed and reported as data', async (t) => {
  const meshRoot = await makeMesh(t);
  // A "bin" that accepts the spawn but never answers any JSON-RPC request.
  const hangBin = join(meshRoot, 'hang.mjs');
  await writeFile(hangBin, 'process.stdin.resume();\nsetInterval(() => {}, 1 << 30);\n');
  const health = createMeshHealth({
    meshRoot,
    binPath: hangBin,
    env: { ...process.env, AGENT_MESH_HEALTH_PING_TIMEOUT_MS: '500' }
  });
  const started = Date.now();
  const out = await health.pingAgent({ name: 'alpha' });
  assert.equal(out.alive, false);
  assert.equal(out.error, 'timeout');
  assert.ok(Date.now() - started < 5_000, 'must not wait beyond the timeout');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/mesh-health.test.js`
Expected: FAIL — `health.pingAgent is not a function`

- [ ] **Step 3: Implement `pingAgent`**

In `src/mesh-health/core.js`, add a module-level helper (below `readPositiveInt`):

```js
// Minimal newline-delimited JSON-RPC requester over a child's stdio (the same
// wire scripts/live-a2a-check.mjs speaks). Rejects Error('timeout') on expiry.
function rpcRequester(child) {
  let buf = '';
  const waiters = new Map();
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); }
    }
  });
  let id = 0;
  return (method, params, timeoutMs) => new Promise((resolveP, rejectP) => {
    const myId = ++id;
    const timer = setTimeout(() => { waiters.delete(myId); rejectP(new Error('timeout')); }, timeoutMs);
    waiters.set(myId, (msg) => { clearTimeout(timer); resolveP(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
    child.once('error', (err) => { clearTimeout(timer); rejectP(err); });
  });
}
```

then add inside `createMeshHealth`:

```js
  async function pingAgent({ name } = {}) {
    if (typeof name !== 'string' || name.length === 0) {
      return { name: name ?? null, alive: false, error: 'bad_input' };
    }
    let entry;
    try {
      const manifest = await readManifest(meshRoot);
      entry = (manifest.agents || []).find((a) => a.name === name);
    } catch (err) {
      return { name, alive: false, error: `manifest_unreadable: ${err.message}` };
    }
    if (!entry) return { name, alive: false, error: 'unknown_agent' };
    if (entry.served === false) return { name, alive: false, error: 'not_served' };
    const agentRoot = resolve(meshRoot, entry.root);

    // process.execPath is node itself — directly spawnable on every platform
    // (no .cmd shim involved), so a raw spawn is safe here.
    let child;
    try {
      child = spawn(process.execPath, [binPath, 'serve-a2a', agentRoot], {
        cwd: agentRoot,
        env: { ...env },
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (err) {
      return { name, alive: false, error: `spawn_failed: ${err.message}` };
    }

    const started = Date.now();
    const call = rpcRequester(child);
    try {
      await call('initialize', { protocolVersion: '1.0' }, pingTimeoutMs);
      await call('ping', {}, pingTimeoutMs);
      return { name, alive: true, latency_ms: Date.now() - started };
    } catch (err) {
      return {
        name,
        alive: false,
        error: err.message === 'timeout' ? 'timeout' : `probe_failed: ${err.message}`
      };
    } finally {
      try { child.stdin.end(); } catch { /* already gone */ }
      killProcessTree(child); // win32: taskkill /T /F; POSIX: signal escalation
    }
  }
```

and extend the return:

```js
  return { triageLogs, checkConformance: checkConformanceVerb, pingAgent };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/mesh-health.test.js`
Expected: PASS (8 tests). The timeout test must finish in well under 5s.

- [ ] **Step 5: Commit**

```bash
git add src/mesh-health/core.js test/mesh-health.test.js
git commit -m "feat(mesh-health): ping_agent verb — real A2A initialize/ping probe with tree-kill timeout"
```

---

### Task 4: stdio MCP server + `serve-mesh-health` CLI verb

**Files:**
- Create: `src/mesh-health/server.js`
- Modify: `src/cli.js` (add hidden verb; add `dirname` to the `node:path` import on line 2)
- Modify: `test/mesh-health.test.js`

- [ ] **Step 1: Write the failing wire test**

Append to `test/mesh-health.test.js`:

```js
// ---------------------------------------------------------------------------
// stdio MCP wire (serve-mesh-health)
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agent-mesh.js');

function wireClient(child) {
  let buf = '';
  const waiters = new Map();
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); }
    }
  });
  let id = 0;
  return (method, params) => new Promise((resolveP) => {
    const myId = ++id;
    waiters.set(myId, resolveP);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
  });
}

test('serve-mesh-health speaks MCP: initialize, tools/list, tools/call', async (t) => {
  const meshRoot = await makeMesh(t);
  const child = spawn(process.execPath, [BIN, 'serve-mesh-health', meshRoot], {
    stdio: ['pipe', 'pipe', 'pipe']
  });
  t.after(() => { try { child.kill(); } catch { /* gone */ } });
  const call = wireClient(child);

  const init = await call('initialize', { protocolVersion: '2024-11-05' });
  assert.equal(init.result.serverInfo.name, 'mesh-health');

  const list = await call('tools/list', {});
  const names = list.result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ['check_conformance', 'ping_agent', 'triage_logs']);

  const triage = await call('tools/call', { name: 'triage_logs', arguments: { since_hours: 1 } });
  const payload = JSON.parse(triage.result.content[0].text);
  assert.equal(payload.agents.length, 1);

  const bad = await call('tools/call', { name: 'nope', arguments: {} });
  assert.ok(bad.error);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/mesh-health.test.js`
Expected: FAIL — the `serve-mesh-health` spawn exits with the usage error, so `initialize` never resolves → test times out or fails on spawn close. (If it hangs, that confirms the verb is missing; Ctrl-C and proceed.)

- [ ] **Step 3: Implement the stdio wrapper**

Create `src/mesh-health/server.js`:

```js
/**
 * src/mesh-health/server.js — stdio MCP wrapper around the mesh-health core.
 *
 * Read-only by design: three verbs (check_conformance / ping_agent /
 * triage_logs), every result a JSON text payload via mcpTextResult. Registered
 * in <mesh-root>/mesh/mcp.json with the x-agentmesh readOnly marker so
 * ask-mode delegations receive it. NOT named agentmesh_* (that prefix is
 * reserved for framework-injected servers and dropped from registry sources).
 */
import { StdioTransport, rpcError } from '../mcp.js';
import { mcpTextResult } from '../contract.js';
import { createMeshHealth } from './core.js';

export const SERVER_NAME = 'mesh-health';

export function createMeshHealthServer({ meshRoot, env = process.env }) {
  const health = createMeshHealth({ meshRoot, env });

  return {
    async start(input, output) {
      const transport = new StdioTransport(input, output, async (message) => {
        const response = await handle(message, health);
        if (response) transport.send(response);
      });
      transport.start();
      await new Promise((resolveP) => input.on('end', resolveP));
    }
  };
}

async function handle(message, health) {
  if (!message || typeof message !== 'object') return null;
  const { id, method, params } = message;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: '0.1.0' }
      }
    };
  }

  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: buildTools() } };
  }

  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};
    if (name === 'check_conformance') {
      return { jsonrpc: '2.0', id, result: mcpTextResult(await health.checkConformance()) };
    }
    if (name === 'ping_agent') {
      return { jsonrpc: '2.0', id, result: mcpTextResult(await health.pingAgent(args)) };
    }
    if (name === 'triage_logs') {
      return { jsonrpc: '2.0', id, result: mcpTextResult(await health.triageLogs(args)) };
    }
    return rpcError(id, -32602, `Unknown tool: ${name}`);
  }

  if (id === undefined) return null;
  return rpcError(id, -32601, `Unknown method: ${method}`);
}

function buildTools() {
  return [
    {
      name: 'check_conformance',
      description:
        'Run the mesh structural conformance check and doctor DRY-RUN over the whole mesh. ' +
        'Returns { ok, counts:{pass,warn,fail}, problems:[{rule,level,detail}], doctor_dry_run } — ' +
        'what `agent-mesh doctor --apply` WOULD fix. Never applies anything.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} }
    },
    {
      name: 'ping_agent',
      description:
        'Liveness-probe one served agent by name: spawns its A2A server and round-trips ' +
        'initialize + ping (no model turn). Returns { name, alive, latency_ms } or ' +
        '{ name, alive:false, error } where error is unknown_agent | not_served | timeout | probe_failed.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: { name: { type: 'string', minLength: 1 } }
      }
    },
    {
      name: 'triage_logs',
      description:
        'Scan agents\' run logs (.agent-mesh/logs) and scheduled-job state for recent failures ' +
        '(timeout / error / refused / rejected). Returns per-agent counts, the most recent ' +
        'failures with log file paths as evidence, and scheduled-job last statuses.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          agent: { type: 'string', minLength: 1, description: 'limit to one agent name' },
          since_hours: { type: 'number', minimum: 1, maximum: 720, description: 'window, default 24' }
        }
      }
    }
  ];
}
```

- [ ] **Step 4: Add the hidden CLI verb**

In `src/cli.js`:

(a) line 2 — extend the path import:

```js
import { resolve, basename, dirname } from 'node:path';
```

(b) insert this block immediately after the `session-exec` block (after line 399, before the `if ((command !== 'serve' …))` gate):

```js
  if (command === 'serve-mesh-health') {
    // Hidden verb: read-only mesh-health MCP server (the mesh-manager agent's
    // tool surface). Mesh root: explicit arg wins; else derived from the
    // framework env every served worker already carries.
    const explicit = argv[1];
    let meshRoot = null;
    try {
      if (explicit) meshRoot = await realpath(resolve(explicit));
      else if (env.AGENT_MESH_MESH_CEILING) meshRoot = env.AGENT_MESH_MESH_CEILING;
      else if (env.AGENT_MESH_MESH_ROOT) meshRoot = dirname(env.AGENT_MESH_MESH_ROOT);
    } catch (err) {
      process.stderr.write(`error: ${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    if (!meshRoot) {
      process.stderr.write('error: serve-mesh-health needs a mesh root (argument, or AGENT_MESH_MESH_CEILING / AGENT_MESH_MESH_ROOT in env)\n');
      process.exitCode = 2;
      return;
    }
    const { createMeshHealthServer } = await import('./mesh-health/server.js');
    const server = createMeshHealthServer({ meshRoot, env });
    await server.start(process.stdin, process.stdout);
    return;
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/mesh-health.test.js`
Expected: PASS (9 tests)

- [ ] **Step 6: Run the full suite (no regressions)**

Run: `npm test`
Expected: PASS (demo-e2e tests skip on Windows — expected, not a failure)

- [ ] **Step 7: Commit**

```bash
git add src/mesh-health/server.js src/cli.js test/mesh-health.test.js
git commit -m "feat(mesh-health): stdio MCP server + hidden serve-mesh-health CLI verb"
```

---

### Task 5: Register `mesh-health` in the live mesh

**Files:**
- Modify: `my-mesh/mesh/mcp.json` (live mesh — NOT committed to the repo)

- [ ] **Step 1: Add the server entry**

Edit `my-mesh/mesh/mcp.json` and add to `mcpServers` (alongside `internal-files` etc.):

```json
"mesh-health": {
  "type": "stdio",
  "command": "node",
  "args": [
    "C:/AI/agents_mesh/bin/agent-mesh.js",
    "serve-mesh-health",
    "C:/AI/agents_mesh/my-mesh"
  ],
  "env": {},
  "description": "Mesh health checks for the mesh-manager agent: conformance dry-run, A2A liveness ping, run-log failure triage. Read-only; never applies fixes.",
  "x-agentmesh": { "readOnly": true }
}
```

The `readOnly` marker is REQUIRED — without it, ask-mode delegations (which is how the scheduler runs every job) never see the server. The mesh-root argument is explicit so the server works even if env derivation changes.

- [ ] **Step 2: Validate the JSON and the registration**

```powershell
node -e "const c=require('./my-mesh/mesh/mcp.json'); console.log('ok:', Object.keys(c.mcpServers).join(', '))"
```

Expected: list includes `mesh-health`.

- [ ] **Step 3: Smoke the registered command line exactly as claude would spawn it**

```powershell
'{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node C:/AI/agents_mesh/bin/agent-mesh.js serve-mesh-health C:/AI/agents_mesh/my-mesh
```

Expected: one JSON line whose `result.tools` has the three tool names. (No repo commit — `my-mesh/` is live-mesh state outside git.)

---

### Task 6: Create the `mesh-manager` agent

**Files (all under the live mesh, NOT committed to the repo):**
- Create: `my-mesh/mesh-manager/` via `agent-mesh add`
- Modify: `my-mesh/mesh.json` (peers wiring)
- Create: `my-mesh/mesh-manager/AGENT.md`, `CLAUDE.md`, `skills/health-report-format/SKILL.md`, `.agent/schedule.json`

- [ ] **Step 1: Scaffold the agent with the builder**

```powershell
New-Item -ItemType Directory -Force C:\AI\agents_mesh\scratch-mesh-manager
node ./bin/agent-mesh.js add ./my-mesh ./scratch-mesh-manager --name mesh-manager --modes ask,do --role "Mesh operations manager — scheduled health sweeps and fix proposals" --apply
Remove-Item -Recurse -Force C:\AI\agents_mesh\scratch-mesh-manager
```

Expected: `Added agent "mesh-manager" to mesh.` with scaffolded anatomy (agent.json, prompts/system.md, canonical dirs) at `my-mesh/mesh-manager/`.

- [ ] **Step 2: Write AGENT.md**

Overwrite `my-mesh/mesh-manager/AGENT.md`:

```markdown
# mesh-manager

Mesh operations manager — runs scheduled health sweeps over the whole mesh and
answers questions about mesh health.

## Capabilities
- Mesh conformance report (structure, cards, wiring) with fix proposals
- Agent liveness probes (A2A initialize/ping, no model turn)
- Run-log and scheduled-job failure triage with log-path evidence
- Dated health reports written as deliverables

## Boundaries
Observer + proposer only: never applies fixes, never edits other agents'
folders or mesh.json. Fix proposals name the exact command for the operator.
```

- [ ] **Step 3: Write CLAUDE.md**

Create/overwrite `my-mesh/mesh-manager/CLAUDE.md`:

```markdown
# mesh-manager — operating instructions

You are the mesh operations manager. You OBSERVE and PROPOSE; you never fix.

## Tools
Your mesh-health tools provide: a mesh conformance check (structural dry-run
with what the doctor would fix), an agent liveness probe by name, and a
run-log/scheduled-job failure triage. Use them for any question about mesh
health — never guess health state from memory. If the tools are unavailable,
say so explicitly in the report.

## Health sweep procedure
1. Check mesh conformance.
2. Probe liveness of every served agent except yourself.
3. Triage logs and scheduled-job state for the requested window (default 24h).
4. Write the report in the health-report-format skill's format.

## Hard rules
- Every finding cites evidence: a log file path or a conformance rule detail.
- Every proposal is an exact command or file change FOR THE OPERATOR
  (e.g. `agent-mesh doctor C:/AI/agents_mesh/my-mesh --apply`).
- Never claim a fix was applied. You have no write access outside your folder.
```

- [ ] **Step 4: Write the report-format skill**

Create `my-mesh/mesh-manager/skills/health-report-format/SKILL.md`:

```markdown
---
name: health-report-format
description: Pinned format for mesh health reports so successive runs stay comparable.
---

# Mesh health report format

Produce exactly these sections, in order:

1. Title + banner:
   `# Mesh Health — YYYY-MM-DD`
   `**Status: GREEN|YELLOW|RED** — <one-line reason>`
   - GREEN: conformance ok, all served agents alive, no failures in window
   - YELLOW: warnings or isolated run failures, but every agent alive
   - RED: any agent unreachable, or conformance has FAIL-level problems
2. `## Agents` — one table row per agent:
   `| Agent | Conformance | Liveness | Runs | Failures |`
   (Liveness as `OK <n>ms` / `DOWN: <error>` / `self` for mesh-manager.)
3. `## Findings` — one bullet per problem, each ending with its evidence in
   parentheses (log file path or conformance rule detail). "No findings." if clean.
4. `## Fix Proposals` — numbered; each one exact operator command or file
   change. "None." if clean.
```

- [ ] **Step 5: Wire peers in mesh.json**

Edit `my-mesh/mesh.json`:
- In the `mesh-manager` entry (added by Step 1), set:
  `"peers": ["knowledge", "data-analyst", "coder", "fracas", "presentation"]`
- Add `"mesh-manager"` to the `peers` array of each of the five existing agents.

Then regenerate the managed registries and verify:

```powershell
node ./bin/agent-mesh.js doctor ./my-mesh --apply
node ./bin/agent-mesh.js validate ./my-mesh
```

Expected: doctor regenerates `registry.json` files; validate ends with `Conformance: OK` (warn-level rules are acceptable; no FAIL).

- [ ] **Step 6: Add the daily sweep job**

Create `my-mesh/mesh-manager/.agent/schedule.json`:

```json
{
  "jobs": [
    {
      "id": "health-sweep",
      "name": "Mesh health sweep",
      "cadence": { "kind": "daily", "at": "08:00" },
      "enabled": true,
      "saveArtifact": true,
      "prompt": "Run a full mesh health sweep for the last 24 hours: check mesh conformance, probe every served agent's liveness (skip yourself), and triage run logs and scheduled-job state. Then write a health report following your health-report-format skill: status banner, per-agent table, findings with evidence paths, and fix proposals for the operator."
    }
  ]
}
```

Note the prompt is phrased FUNCTIONALLY (no MCP tool names) — per the CLAUDE.md lesson, first-turn tool enumeration races MCP registration in headless `claude -p`.

- [ ] **Step 7: Verify the agent's card renders**

```powershell
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"1.0"}}' | node ./bin/agent-mesh.js serve-a2a ./my-mesh/mesh-manager
```

Expected: one JSON line containing `"agentCard"` with `"name":"mesh-manager"`.

---

### Task 7: End-to-end verification

- [ ] **Step 1: Full hermetic suite**

Run: `npm test`
Expected: PASS (Windows skips in demo-e2e are expected).

- [ ] **Step 2: Live sweep through a real delegation (real `claude`, ~1-3 min)**

```powershell
$env:AGENT_MESH_MESH_ROOT = "C:/AI/agents_mesh/my-mesh/mesh"
$env:AGENT_MESH_MESH_CEILING = "C:/AI/agents_mesh/my-mesh"
node ./bin/agent-mesh.js serve ./my-mesh/mesh-manager
```

then paste one line into its stdin:

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"delegate_task","arguments":{"mode":"ask","task":"Run a mesh health sweep for the last 24 hours and produce the report in your pinned format."}}}
```

Expected: a `status:"done"` result whose summary is a health report with the four pinned sections; conformance/liveness/triage numbers consistent with `agent-mesh validate ./my-mesh`. (Ctrl-C the server afterwards.)

- [ ] **Step 3: Dashboard check**

Run: `node ./bin/agent-mesh.js dashboard ./my-mesh --no-open` and open the printed URL.
Expected: `mesh-manager` appears as a sixth agent card/node; its scheduled job "Mesh health sweep" is listed; "Run now" on the job produces an artifact under its deliverables.

- [ ] **Step 4: Update docs**

Add `serve-mesh-health` to the architecture bullet list in `CLAUDE.md` (one line under Architecture: `src/mesh-health/`: read-only health verbs for the mesh-manager agent — conformance dry-run, A2A liveness ping, log triage; registered per-mesh in `mesh/mcp.json` with the readOnly marker) and the new env var `AGENT_MESH_HEALTH_PING_TIMEOUT_MS` (10000) to the Config section. Mention the agent pattern in `PROJECT.md` ONLY if PROJECT.md's wire contract is unaffected (it is — no protocol change; skip if unsure).

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: mesh-health server + mesh-manager agent pattern"
```

---

## Self-review notes (already applied)

- Spec coverage: agent anatomy (Task 6), MCP server + three verbs (Tasks 1-4), readOnly registration (Task 5), daily sweep + report skill (Task 6), error-as-data + tree-kill timeout (Tasks 1-3), hermetic tests + wire test + live check (Tasks 1-4, 7). Spec's "extend live-a2a-check.mjs" is satisfied by Task 7 Step 2's live delegation instead — same evidence, less script surface.
- Type consistency: core returns `{ triageLogs, checkConformance, pingAgent }`; server calls exactly those; tool names on the wire are `check_conformance` / `ping_agent` / `triage_logs` everywhere.
- The `ok`-status set covers both log families: delegate finals use `done`, a2a bridge finals use `completed`; everything else (`timeout`, `error`, `refused`, `rejected`, `failed`) counts as failure.
