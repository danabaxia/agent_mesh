# A2A Behavior Evaluation Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone scorecard runner (`scripts/eval-a2a.mjs`) that measures real-`claude` A2A behavior quality — delegation decisions, peer selection, multi-turn memory, reset semantics, refusal handling — with deterministic ground-truth probes.

**Architecture:** `eval/` holds the harness (mesh fixtures + A2A driver), probes, scorecard math, and 8 scenario modules. The runner drives agent A over the real A2A wire (`createA2AClient → SendMessage`), plants random facts so answers can only come from peers/transcripts, and scores binary probes from artifacts the framework already emits (run-log `parent_run_id` edges, `--resume`/`--session-id` argv, git-clean). K trials per scenario (default 3); output is a pass-rate scorecard, never a test gate. The harness itself is hermetically tested in `npm test` with a fake `claude`.

**Tech Stack:** Node ≥20, zero-dependency ESM, `node --test` for hermetic harness tests. Real `claude` only inside `scripts/eval-a2a.mjs` runs.

**Spec:** [docs/superpowers/specs/2026-06-10-a2a-behavior-evals-design.md](../specs/2026-06-10-a2a-behavior-evals-design.md)

**Fixture-prompt rule (CLAUDE.md lesson, applies to every scenario task string):** frame tasks honestly — declare confinement/refusal fixtures as the framework's own tests, use neutral filenames, never deceptive bait; deceptive framing makes the model refuse before the mesh runs.

---

## File structure

| File | Responsibility | New/Modify |
|---|---|---|
| `src/agent-context.js` | `AGENT_MESH_EVAL_NO_ROSTER` seam in `renderPeersBlock` (env threaded in) | Modify |
| `src/delegate-invocation.js` | pass `env` into both `buildAgentRuntimePrompt` calls | Modify |
| `eval/harness.mjs` | `plant`, `buildMesh`, `driveAgent`, `readRuns`, `gitClean`, `cleanupMesh` | **New** |
| `eval/probes.mjs` | probe constructors + `sessionArg` | **New** |
| `eval/scorecard.mjs` | trial/scenario/aggregate scoring, markdown render, writer, exit code | **New** |
| `eval/runner.mjs` | `runScenario` loop (build → drive → probe → preserve-on-fail → teardown) | **New** |
| `eval/scenarios/01-should-delegate.mjs` … `08-refusal-is-data.mjs` | one module per scenario | **New** |
| `scripts/eval-a2a.mjs` | CLI: `--list --scenario --trials --timeout-ms --out --min-pass-rate` | **New** |
| `test/peer-discovery.test.js` | roster-seam test | Modify |
| `test/eval-harness.test.js` | hermetic tests: fixtures, probes, scorecard, driver | **New** |
| `.gitignore` | ignore `eval-results/` | Modify |
| `CLAUDE.md` | Commands section: eval runner usage | Modify |

---

## Task 1: roster suppression seam (`AGENT_MESH_EVAL_NO_ROSTER`)

**Files:**
- Modify: `src/agent-context.js` (`buildAgentRuntimePrompt` opts, `renderPeersBlock`)
- Modify: `src/delegate-invocation.js:40` and `:213`
- Test: `test/peer-discovery.test.js`

- [ ] **Step 1: Write the failing test** — append to `test/peer-discovery.test.js`:

```js
test('AGENT_MESH_EVAL_NO_ROSTER=1 suppresses the roster block (eval A/B seam)', async () => {
  const { aRoot } = await meshWithPeers({ library: 'Library catalog agent.' });
  const on = await buildAgentRuntimePrompt(aRoot, 'ask', {});
  assert.match(on, /- library: /, 'roster present by default');
  const off = await buildAgentRuntimePrompt(aRoot, 'ask', { env: { AGENT_MESH_EVAL_NO_ROSTER: '1' } });
  assert.ok(!off || !off.includes('- library: '), 'roster suppressed by seam');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/peer-discovery.test.js`
Expected: FAIL — the seam is ignored, roster present in both prompts.

- [ ] **Step 3: Implement** — in `src/agent-context.js` change the signature and gate:

```js
// signature line:
export async function buildAgentRuntimePrompt(root, mode, { meshRoot, env } = {}) {
// ... unchanged body ...
//   const peersBlock = await renderPeersBlock(root);          // BEFORE
    const peersBlock = await renderPeersBlock(root, env);      // AFTER
```

and at the top of `renderPeersBlock`:

```js
async function renderPeersBlock(root, env) {
  // Eval-only A/B seam: removal-only (can only DELETE prompt content), operator
  // env, mirrors AGENT_MESH_TEST_PLATFORM. Used by eval scenario 04 to measure
  // the roster's effect on delegation rate.
  if ((env ?? process.env).AGENT_MESH_EVAL_NO_ROSTER === '1') return null;
  // ... existing body unchanged ...
```

In `src/delegate-invocation.js`, both call sites:

```js
const identity = await buildAgentRuntimePrompt(root, mode, { meshRoot, env });   // line ~40
const identity = await buildAgentRuntimePrompt(root, 'ask', { meshRoot, env });  // line ~213
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/peer-discovery.test.js test/agent-context.test.js test/delegate-invocation.test.js`
Expected: PASS (seam works; existing suites unaffected — `env` was already in scope at both call sites).

- [ ] **Step 5: Commit**

```bash
git add src/agent-context.js src/delegate-invocation.js test/peer-discovery.test.js
git commit -m "feat(eval): AGENT_MESH_EVAL_NO_ROSTER seam for roster A/B measurement"
```

---

## Task 2: harness — fixtures, run-log reader, cleanup

**Files:**
- Create: `eval/harness.mjs`
- Test: `test/eval-harness.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/eval-harness.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildMesh, readRuns, gitClean, cleanupMesh, plant } from '../eval/harness.mjs';
import { readManagedRegistry } from '../src/a2a/registry.js';

test('plant produces unique non-dictionary tokens', () => {
  const a = plant('FACT'); const b = plant('FACT');
  assert.match(a, /^FACT-[0-9a-f]{8}$/);
  assert.notEqual(a, b);
});

test('buildMesh: marker-valid registries, manifest, git-clean seeded agents', async () => {
  const mesh = await buildMesh({
    agents: {
      A: { peers: ['B'] },
      B: { agentMd: 'Library agent. Capabilities: lookup.', files: { 'data/fact.md': 'X' } }
    },
    claude: '/bin/true'
  });
  try {
    const reg = await readManagedRegistry(mesh.agents.A.root);
    assert.equal(reg.ok, true);
    assert.deepEqual(Object.keys(reg.registry.peers), ['B']);
    const peerB = reg.registry.peers.B;
    assert.equal(peerB.root, mesh.agents.B.root);
    assert.equal(peerB.env.AGENT_MESH_MESH_CEILING, mesh.meshRoot);
    assert.equal(peerB.env.AGENT_MESH_LOG_DIR, mesh.agents.B.logDir);
    const manifest = JSON.parse(await readFile(join(mesh.meshRoot, 'mesh.json'), 'utf8'));
    assert.deepEqual(manifest.agents.map((a) => a.name).sort(), ['A', 'B']);
    assert.equal(await gitClean(mesh.agents.B), true);   // seeded files committed
    await writeFile(join(mesh.agents.B.root, 'data/fact.md'), 'tampered');
    assert.equal(await gitClean(mesh.agents.B), false);  // detects change
  } finally { await cleanupMesh(mesh); }
});

test('readRuns: parses, dedupes by id (last wins), keeps done only, sorted', async () => {
  const mesh = await buildMesh({ agents: { A: {} }, claude: '/bin/true' });
  try {
    const dir = mesh.agents.A.logDir;
    await mkdir(dir, { recursive: true });
    const lines = [
      { id: 'r1', state: 'started', started_at: '2026-06-10T01:00:00Z' },
      { id: 'r1', state: 'done', status: 'done', started_at: '2026-06-10T01:00:00Z', parent_run_id: 'p0' },
      { id: 'r2', state: 'done', status: 'error', started_at: '2026-06-10T02:00:00Z' }
    ].map((r) => JSON.stringify(r)).join('\n');
    await writeFile(join(dir, 'delegate-2026-06-10.jsonl'), lines + '\n');
    const runs = await readRuns(mesh.agents.A);
    assert.equal(runs.length, 2);
    assert.deepEqual(runs.map((r) => r.id), ['r1', 'r2']);   // sorted by started_at
    assert.equal(runs[0].parent_run_id, 'p0');               // final record won
  } finally { await cleanupMesh(mesh); }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/eval-harness.test.js`
Expected: FAIL — `Cannot find module '../eval/harness.mjs'`.

- [ ] **Step 3: Implement `eval/harness.mjs`**

```js
// eval/harness.mjs — fixtures + A2A driver for the behavior eval suite.
// Spec: docs/superpowers/specs/2026-06-10-a2a-behavior-evals-design.md
import { mkdtemp, mkdir, writeFile, rm, realpath, readdir } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

import { BIN_PATH } from '../src/delegate-invocation.js';
import { readRunLogRecords, dedupeRunRecords } from '../src/log.js';
import { encodeProjectDir } from '../src/session-transcripts.js';
import { createA2AClient } from '../src/a2a/stdio-client.js';

const execFileAsync = promisify(execFile);

/** Random ground-truth token — unguessable from world knowledge. */
export function plant(prefix = 'FACT') {
  return `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

/**
 * Materialize a disposable mesh.
 * agents: { NAME: { agentMd?, files?: {rel: text}, peers?: [names], env?: {} } }
 * Every agent is git-init-ed and its seed files committed (gitClean probes).
 * Agents with `peers` get a marked registry.json shaped exactly like
 * generateRegistry output (root/command/args/env incl. MESH_ROOT/CEILING).
 * Run logs go to a per-agent dir OUTSIDE the mesh (spec §5 confound note).
 */
export async function buildMesh({ agents = {}, claude, timeoutMs = 120_000 } = {}) {
  const meshRoot = await mkdtemp(join(tmpdir(), 'a2a-eval-'));
  const logsBase = await mkdtemp(join(tmpdir(), 'a2a-eval-logs-'));
  const out = { meshRoot, logsBase, agents: {} };
  for (const name of Object.keys(agents)) {
    const root = join(meshRoot, name);
    await mkdir(root, { recursive: true });
    out.agents[name] = { name, root, logDir: join(logsBase, name) };
  }
  await writeFile(join(meshRoot, 'mesh.json'), JSON.stringify({
    'x-agentmesh-generated': true,
    meshVersion: '1',
    agents: Object.keys(agents).map((name) => ({ name, root: `./${name}` }))
  }));
  for (const [name, spec] of Object.entries(agents)) {
    const a = out.agents[name];
    if (spec.agentMd) await writeFile(join(a.root, 'AGENT.md'), spec.agentMd);
    for (const [rel, text] of Object.entries(spec.files || {})) {
      await mkdir(dirname(join(a.root, rel)), { recursive: true });
      await writeFile(join(a.root, rel), text);
    }
    if (Array.isArray(spec.peers) && spec.peers.length > 0) {
      const peers = {};
      for (const pn of spec.peers) {
        const p = out.agents[pn];
        peers[pn] = {
          root: p.root,
          command: process.execPath,
          args: [BIN_PATH, 'serve-a2a', p.root],
          cwd: p.root,
          env: peerEnv(out, p, claude, timeoutMs, agents[pn]?.env)
        };
      }
      await writeFile(join(a.root, 'registry.json'),
        JSON.stringify({ 'x-agentmesh-generated': true, peers }));
    }
    await execFileAsync('git', ['init', '-q'], { cwd: a.root });
    await execFileAsync('git', ['add', '-A'], { cwd: a.root });
    await execFileAsync('git', ['-c', 'user.email=eval@local', '-c', 'user.name=eval',
      'commit', '-qm', 'seed', '--allow-empty'], { cwd: a.root });
  }
  return out;
}

function peerEnv(mesh, agent, claude, timeoutMs, extra) {
  return {
    AGENT_MESH_ENABLED_MODES: 'ask',
    AGENT_MESH_MESH_ROOT: join(mesh.meshRoot, 'mesh'),
    AGENT_MESH_MESH_CEILING: mesh.meshRoot,
    AGENT_MESH_CLAUDE: claude,
    AGENT_MESH_LOG_DIR: agent.logDir,
    AGENT_MESH_TIMEOUT_MS: String(timeoutMs),
    ...(extra || {})
  };
}

/**
 * Drive one agent over the REAL A2A wire: spawn `serve-a2a <root>` via
 * createA2AClient and send the turns in order. Each turn carries a UNIQUE
 * `agentmesh/caller` tag so the driven agent never resumes ITS OWN thread
 * across eval turns — the only cross-turn memory channel is then the
 * peer-side `from:<agent>` session, which is exactly what scenarios 5/6
 * measure. Returns [{ answer, runId, state, errorCode, task }] per turn.
 */
export async function driveAgent(mesh, agentName, turns,
  { claude, timeoutMs = 180_000, callerTag = 'eval', agentEnv = {} } = {}) {
  const a = mesh.agents[agentName];
  const registry = { peers: { [agentName]: {
    root: a.root,
    command: process.execPath,
    args: [BIN_PATH, 'serve-a2a', a.root],
    cwd: a.root,
    env: { ...peerEnv(mesh, a, claude, timeoutMs), ...agentEnv }
  } } };
  const client = await createA2AClient(registry, {
    env: process.env, requestTimeoutMs: timeoutMs + 60_000
  });
  const results = [];
  try {
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      const message = {
        messageId: randomUUID(),
        role: 'ROLE_USER',
        parts: [{ text: t.task }],
        metadata: { 'agentmesh/mode': 'ask', 'agentmesh/caller': `${callerTag}-t${i}`, ...(t.metadata || {}) }
      };
      const task = await client.send(agentName, message);
      results.push(toResult(task));
    }
  } finally {
    await client.close().catch(() => {});
  }
  return results;
}

function toResult(task) {
  const answer = (task?.artifacts ?? [])
    .flatMap((a) => (Array.isArray(a.parts) ? a.parts : []))
    .filter((p) => p && typeof p.text === 'string')
    .map((p) => p.text).join('\n');
  return {
    answer,
    runId: task?.metadata?.['agentmesh/run_id'] ?? null,
    state: task?.status?.state ?? null,
    errorCode: task?.metadata?.['agentmesh/error_code'] ?? null,
    task
  };
}

/** Final (state:'done') delegate records for one agent, sorted by started_at. */
export async function readRuns(agent) {
  let files = [];
  try { files = await readdir(agent.logDir); } catch { return []; }
  const recs = [];
  for (const f of files.filter((n) => n.startsWith('delegate-') && n.endsWith('.jsonl')).sort()) {
    recs.push(...await readRunLogRecords(join(agent.logDir, f)));
  }
  return dedupeRunRecords(recs)
    .filter((r) => r.state === 'done')
    .sort((x, y) => String(x.started_at).localeCompare(String(y.started_at)));
}

export async function gitClean(agent) {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: agent.root });
  return stdout.trim() === '';
}

/** Remove the temp mesh + logs + the real-claude transcript dirs it created. */
export async function cleanupMesh(mesh) {
  for (const a of Object.values(mesh.agents)) {
    try {
      const enc = encodeProjectDir(await realpath(a.root));
      await rm(join(homedir(), '.claude', 'projects', enc), { recursive: true, force: true });
    } catch { /* best-effort */ }
  }
  await rm(mesh.meshRoot, { recursive: true, force: true });
  await rm(mesh.logsBase, { recursive: true, force: true });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/eval-harness.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add eval/harness.mjs test/eval-harness.test.js
git commit -m "feat(eval): harness — mesh fixtures, A2A driver, run-log reader, cleanup"
```

---

## Task 3: probes

**Files:**
- Create: `eval/probes.mjs`
- Test: extend `test/eval-harness.test.js`

Probe contract: `{ name, check(ctx) → { pass, detail } }` where
`ctx = { results, runs: {NAME: [records]}, mesh, planted }`.

- [ ] **Step 1: Write the failing test** — append to `test/eval-harness.test.js`:

```js
import { probe, sessionArg } from '../eval/probes.mjs';

test('probes: each fires correctly in both directions on synthetic artifacts', async () => {
  const ctx = {
    results: [{ answer: 'The code is FACT-aa11bb22.', runId: 'rA' }],
    runs: {
      B: [{ id: 'rB', parent_run_id: 'rA', argv: ['-p', 'x', '--session-id', 's-1'], started_at: '1' }],
      C: []
    },
    mesh: null, planted: {}
  };
  assert.equal((await probe.peerRan('B').check(ctx)).pass, true);
  assert.equal((await probe.peerRan('C').check(ctx)).pass, false);
  assert.equal((await probe.noPeerRan(['C']).check(ctx)).pass, true);
  assert.equal((await probe.noPeerRan(['B']).check(ctx)).pass, false);
  assert.equal((await probe.answerContains(0, 'FACT-aa11bb22').check(ctx)).pass, true);
  assert.equal((await probe.answerContains(0, 'FACT-zz').check(ctx)).pass, false);
  assert.equal((await probe.answerNotContains(0, 'FACT-zz').check(ctx)).pass, true);
  assert.deepEqual(sessionArg(ctx.runs.B[0]), { flag: '--session-id', id: 's-1' });
  assert.equal(sessionArg({ argv: ['-p', 'x'] }), null);
  // peerRanUnder: C parented by B
  const ctx2 = { ...ctx, runs: { B: ctx.runs.B, C: [{ id: 'rC', parent_run_id: 'rB', started_at: '2' }] } };
  assert.equal((await probe.peerRanUnder('C', 'B').check(ctx2)).pass, true);
  assert.equal((await probe.peerRanUnder('C', 'B').check(ctx)).pass, false);
});

test('probes: peersClean and fileAbsent inspect the real mesh', async () => {
  const mesh = await buildMesh({ agents: { B: { files: { 'a.txt': 'x' } } }, claude: '/bin/true' });
  try {
    const ctx = { results: [], runs: {}, mesh, planted: {} };
    assert.equal((await probe.peersClean(['B']).check(ctx)).pass, true);
    assert.equal((await probe.fileAbsent('DONE.txt').check(ctx)).pass, true);
    await writeFile(join(mesh.agents.B.root, 'DONE.txt'), 'oops');
    assert.equal((await probe.peersClean(['B']).check(ctx)).pass, false);
    assert.equal((await probe.fileAbsent('DONE.txt').check(ctx)).pass, false);
  } finally { await cleanupMesh(mesh); }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/eval-harness.test.js`
Expected: FAIL — `Cannot find module '../eval/probes.mjs'`.

- [ ] **Step 3: Implement `eval/probes.mjs`**

```js
// eval/probes.mjs — deterministic ground-truth probes (spec §5).
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { gitClean } from './harness.mjs';

/** Extract the session flag a delegate run was spawned with (from logged argv). */
export function sessionArg(run) {
  const a = Array.isArray(run?.argv) ? run.argv : [];
  for (const flag of ['--resume', '--session-id']) {
    const i = a.indexOf(flag);
    if (i !== -1) return { flag, id: a[i + 1] };
  }
  return null;
}

const result = (pass, detail) => ({ pass, detail });

export const probe = {
  /** The peer executed a run parented by the driven agent's turn-N run id. */
  peerRan(peer, { turn = 0 } = {}) {
    return { name: `peerRan(${peer})`, async check(ctx) {
      const anchor = ctx.results[turn]?.runId;
      const hit = (ctx.runs[peer] || []).find((r) => anchor && r.parent_run_id === anchor);
      return result(Boolean(hit), hit ? `run ${hit.id}` : `no ${peer} run with parent_run_id=${anchor}`);
    } };
  },

  /** Two-hop edge: `peer` ran parented by one of `parentPeer`'s run ids. */
  peerRanUnder(peer, parentPeer) {
    return { name: `peerRanUnder(${peer}<-${parentPeer})`, async check(ctx) {
      const parents = new Set((ctx.runs[parentPeer] || []).map((r) => r.id));
      const hit = (ctx.runs[peer] || []).find((r) => parents.has(r.parent_run_id));
      return result(Boolean(hit), hit ? `run ${hit.id} parent=${hit.parent_run_id}` : `no ${peer} run parented by ${parentPeer}`);
    } };
  },

  /** None of the listed peers executed any run. */
  noPeerRan(peers) {
    return { name: `noPeerRan(${peers.join(',')})`, async check(ctx) {
      const ran = peers.filter((p) => (ctx.runs[p] || []).length > 0);
      return result(ran.length === 0, ran.length ? `unexpected runs in: ${ran.join(',')}` : 'no peer runs');
    } };
  },

  answerContains(turn, text) {
    return { name: `answerContains(t${turn}, ${text})`, async check(ctx) {
      const answer = ctx.results[turn]?.answer ?? '';
      return result(answer.includes(text), answer.slice(0, 200));
    } };
  },

  answerNotContains(turn, text) {
    return { name: `answerNotContains(t${turn}, ${text})`, async check(ctx) {
      const answer = ctx.results[turn]?.answer ?? '';
      return result(!answer.includes(text), answer.slice(0, 200));
    } };
  },

  /** Listed agents' folders are git-clean (no task output written). */
  peersClean(names) {
    return { name: `peersClean(${names.join(',')})`, async check(ctx) {
      const dirty = [];
      for (const n of names) if (!(await gitClean(ctx.mesh.agents[n]))) dirty.push(n);
      return result(dirty.length === 0, dirty.length ? `dirty: ${dirty.join(',')}` : 'all clean');
    } };
  },

  /** `rel` does not exist in ANY agent folder of the mesh. */
  fileAbsent(rel) {
    return { name: `fileAbsent(${rel})`, async check(ctx) {
      const found = [];
      for (const a of Object.values(ctx.mesh.agents)) {
        try { await access(join(a.root, rel)); found.push(a.name); } catch { /* absent — good */ }
      }
      return result(found.length === 0, found.length ? `present in: ${found.join(',')}` : 'absent everywhere');
    } };
  }
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/eval-harness.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add eval/probes.mjs test/eval-harness.test.js
git commit -m "feat(eval): deterministic probes over run-log edges, answers, git state"
```

---

## Task 4: scorecard

**Files:**
- Create: `eval/scorecard.mjs`
- Test: extend `test/eval-harness.test.js`

- [ ] **Step 1: Write the failing test** — append to `test/eval-harness.test.js`:

```js
import { aggregate, renderMarkdown, exitCode } from '../eval/scorecard.mjs';

test('scorecard: aggregation, markdown, threshold exit code', () => {
  const report = aggregate([
    { name: 's1', trials: [
      { trial: 0, pass: true, probes: [], durationMs: 100 },
      { trial: 1, pass: false, probes: [{ name: 'p', pass: false, detail: 'd' }], durationMs: 120 }
    ] },
    { name: 's4', compare: { roster: { delegationRate: 1 }, noRoster: { delegationRate: 0.33 } } }
  ]);
  assert.equal(report.scenarios[0].passRate, 0.5);
  assert.equal(report.aggregate.passRate, 0.5);          // compare entries excluded
  assert.equal(report.aggregate.trials, 2);
  const md = renderMarkdown(report);
  assert.match(md, /s1.*50%/s);
  assert.match(md, /s4/);
  assert.equal(exitCode(report, undefined), 0);          // no threshold → always 0
  assert.equal(exitCode(report, 0.4), 0);
  assert.equal(exitCode(report, 0.9), 1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/eval-harness.test.js`
Expected: FAIL — `Cannot find module '../eval/scorecard.mjs'`.

- [ ] **Step 3: Implement `eval/scorecard.mjs`**

```js
// eval/scorecard.mjs — scoring + report rendering (spec §6).
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function aggregate(scenarioReports) {
  const scenarios = scenarioReports.map((s) => {
    if (s.compare) return s;                               // A/B entries pass through
    const passed = s.trials.filter((t) => t.pass).length;
    return { ...s, passed, passRate: s.trials.length ? passed / s.trials.length : 0 };
  });
  const scored = scenarios.filter((s) => !s.compare);
  const trials = scored.reduce((n, s) => n + s.trials.length, 0);
  const passed = scored.reduce((n, s) => n + s.passed, 0);
  return {
    at: new Date().toISOString(),
    scenarios,
    aggregate: { trials, passed, passRate: trials ? passed / trials : 0 }
  };
}

const pct = (x) => `${Math.round(x * 100)}%`;

export function renderMarkdown(report) {
  const lines = [`# A2A behavior eval — ${report.at}`, '',
    `**Aggregate: ${report.aggregate.passed}/${report.aggregate.trials} trials (${pct(report.aggregate.passRate)})**`, '',
    '| scenario | result | detail |', '|---|---|---|'];
  for (const s of report.scenarios) {
    if (s.compare) {
      const arms = Object.entries(s.compare)
        .map(([arm, v]) => `${arm}: ${pct(v.delegationRate)}`).join(' vs ');
      lines.push(`| ${s.name} | A/B | ${arms} |`);
      continue;
    }
    const fails = s.trials.filter((t) => !t.pass)
      .map((t) => `t${t.trial}: ${(t.probes.find((p) => !p.pass) || {}).name || '?'}`).join('; ');
    lines.push(`| ${s.name} | ${s.passed}/${s.trials.length} (${pct(s.passRate)}) | ${fails || 'all pass'} |`);
  }
  return lines.join('\n') + '\n';
}

export async function writeScorecard(outDir, report) {
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'scorecard.json'), JSON.stringify(report, null, 2));
  await writeFile(join(outDir, 'scorecard.md'), renderMarkdown(report));
  return { json: join(outDir, 'scorecard.json'), md: join(outDir, 'scorecard.md') };
}

/** 0 always, unless a threshold is set and the aggregate falls below it. */
export function exitCode(report, minPassRate) {
  if (minPassRate === undefined || minPassRate === null) return 0;
  return report.aggregate.passRate >= Number(minPassRate) ? 0 : 1;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/eval-harness.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add eval/scorecard.mjs test/eval-harness.test.js
git commit -m "feat(eval): scorecard aggregation, markdown render, threshold exit"
```

---

## Task 5: runner core + CLI (hermetic end-to-end with fake claude)

**Files:**
- Create: `eval/runner.mjs`
- Create: `scripts/eval-a2a.mjs`
- Test: extend `test/eval-harness.test.js`

- [ ] **Step 1: Write the failing test** — append to `test/eval-harness.test.js`. This drives a REAL `serve-a2a` subprocess but with a fake `claude`, proving the full build→drive→probe→teardown loop hermetically:

```js
import { mkdtemp, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { runScenario } from '../eval/runner.mjs';
import { probe as P } from '../eval/probes.mjs';

async function fakeClaude(body) {
  const dir = await mkdtemp(join(tmpdir(), 'eval-fc-'));
  const p = join(dir, 'fake-claude.mjs');
  await writeFile(p, `#!/usr/bin/env node\n${body}\n`);
  await chmod(p, 0o755);
  return p;
}

test('runner: full hermetic loop — build, drive over real serve-a2a, probe, score', { timeout: 60_000 }, async () => {
  // fake worker: echoes the planted fact it finds in its own folder.
  const fc = await fakeClaude(`
    const fs = await import('node:fs/promises');
    let fact = 'none';
    try { fact = (await fs.readFile('notes.md', 'utf8')).trim(); } catch {}
    console.log('The answer is ' + fact);`);
  const fact = plant('FACT');
  const scenario = {
    name: 'hermetic-smoke',
    async setup(h) {
      const mesh = await h.buildMesh({
        agents: { A: { files: { 'notes.md': fact }, peers: ['B'] }, B: {} },
        claude: fc
      });
      return {
        mesh, driven: 'A',
        turns: [{ task: 'What does your notes file say?' }],
        probes: [h.probe.answerContains(0, fact), h.probe.noPeerRan(['B'])]
      };
    }
  };
  const rep = await runScenario(scenario, { trials: 2, claude: fc, timeoutMs: 30_000, outDir: await mkdtemp(join(tmpdir(), 'eval-out-')) });
  assert.equal(rep.trials.length, 2);
  assert.equal(rep.trials.every((t) => t.pass), true, JSON.stringify(rep.trials, null, 2));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/eval-harness.test.js`
Expected: FAIL — `Cannot find module '../eval/runner.mjs'`.

- [ ] **Step 3a: Implement `eval/runner.mjs`**

```js
// eval/runner.mjs — per-scenario trial loop (spec §3, §6).
import { mkdir, cp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as harness from './harness.mjs';
import { probe } from './probes.mjs';

// The API handed to scenario setup()/run() — everything a scenario may use.
export const api = { ...harness, probe };

export async function runScenario(scenario, { trials = 3, claude, timeoutMs = 180_000, outDir, log = () => {} }) {
  // Custom-run scenarios (e.g. 04 roster A/B) own their whole loop.
  if (typeof scenario.run === 'function') {
    return scenario.run(api, { trials, claude, timeoutMs, outDir, log });
  }
  const trialReports = [];
  for (let trial = 0; trial < trials; trial++) {
    const t0 = Date.now();
    const setup = await scenario.setup(api);
    let trialReport;
    try {
      const results = await harness.driveAgent(setup.mesh, setup.driven, setup.turns, {
        claude, timeoutMs, agentEnv: setup.agentEnv || {},
        callerTag: `eval-${scenario.name}-${trial}`
      });
      const runs = {};
      for (const name of Object.keys(setup.mesh.agents)) {
        runs[name] = await harness.readRuns(setup.mesh.agents[name]);
      }
      const ctx = { results, runs, mesh: setup.mesh, planted: setup.planted || {} };
      const probes = [];
      for (const p of setup.probes) probes.push({ name: p.name, ...(await p.check(ctx)) });
      const pass = probes.every((p) => p.pass);
      trialReport = { trial, pass, probes, durationMs: Date.now() - t0 };
      if (!pass && outDir) await preserve(outDir, scenario.name, trial, setup.mesh, results);
    } catch (err) {
      trialReport = { trial, pass: false, probes: [{ name: 'harness', pass: false, detail: err.message }], durationMs: Date.now() - t0 };
    } finally {
      await harness.cleanupMesh(setup.mesh).catch(() => {});
    }
    log(`  ${scenario.name} trial ${trial}: ${trialReport.pass ? 'PASS' : 'FAIL'}`);
    trialReports.push(trialReport);
  }
  return { name: scenario.name, trials: trialReports };
}

// Preserve failed-trial evidence BEFORE teardown: answers + all run logs.
async function preserve(outDir, name, trial, mesh, results) {
  const dir = join(outDir, 'failures', `${name}-t${trial}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'answers.json'),
    JSON.stringify(results.map((r) => ({ answer: r.answer, runId: r.runId, state: r.state })), null, 2));
  await cp(mesh.logsBase, join(dir, 'logs'), { recursive: true }).catch(() => {});
}
```

- [ ] **Step 3b: Implement `scripts/eval-a2a.mjs`**

```js
#!/usr/bin/env node
// A2A behavior eval runner (spec: docs/superpowers/specs/2026-06-10-a2a-behavior-evals-design.md)
// Usage: node scripts/eval-a2a.mjs [--list] [--scenario NAME] [--trials N]
//        [--timeout-ms N] [--out DIR] [--min-pass-rate 0..1]
import { readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { runScenario } from '../eval/runner.mjs';
import { aggregate, writeScorecard, exitCode, renderMarkdown } from '../eval/scorecard.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
  const opts = { trials: 3, timeoutMs: 180_000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') opts.list = true;
    else if (a === '--scenario') opts.scenario = argv[++i];
    else if (a === '--trials') opts.trials = Number(argv[++i]);
    else if (a === '--timeout-ms') opts.timeoutMs = Number(argv[++i]);
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--min-pass-rate') opts.minPassRate = Number(argv[++i]);
    else { console.error(`unknown arg: ${a}`); process.exit(2); }
  }
  return opts;
}

async function loadScenarios() {
  const dir = join(repoRoot, 'eval', 'scenarios');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.mjs')).sort();
  const out = [];
  for (const f of files) out.push((await import(pathToFileURL(join(dir, f)).href)).default);
  return out;
}

function detectClaude() {
  const bin = process.env.AGENT_MESH_CLAUDE || 'claude';
  try { execFileSync(bin, ['--version'], { stdio: 'pipe' }); return bin; }
  catch {
    console.error(`cannot run "${bin}" — install claude or set AGENT_MESH_CLAUDE.`);
    process.exit(2);
  }
}

const opts = parseArgs(process.argv.slice(2));
const scenarios = await loadScenarios();
if (opts.list) {
  for (const s of scenarios) console.log(s.name);
  process.exit(0);
}
const selected = opts.scenario ? scenarios.filter((s) => s.name === opts.scenario) : scenarios;
if (selected.length === 0) { console.error(`no scenario named "${opts.scenario}"`); process.exit(2); }

const claude = detectClaude();
const outDir = opts.out || join(repoRoot, 'eval-results', new Date().toISOString().replace(/[:.]/g, '-'));
console.log(`eval-a2a: ${selected.length} scenario(s) × ${opts.trials} trial(s) → ${outDir}`);

const reports = [];
for (const s of selected) {
  console.log(`\n▶ ${s.name}`);
  reports.push(await runScenario(s, { ...opts, claude, outDir, log: console.log }));
}
const report = aggregate(reports);
const paths = await writeScorecard(outDir, report);
console.log(`\n${renderMarkdown(report)}`);
console.log(`scorecard: ${paths.md}`);
process.exit(exitCode(report, opts.minPassRate));
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/eval-harness.test.js`
Expected: PASS (7 tests, including the hermetic full-loop runner test).

- [ ] **Step 5: Commit**

```bash
git add eval/runner.mjs scripts/eval-a2a.mjs test/eval-harness.test.js
git commit -m "feat(eval): runner loop + eval-a2a CLI (scorecard, failure artifacts)"
```

---

## Task 6: scenarios 1, 2, 3, 8 (single-turn)

**Files:**
- Create: `eval/scenarios/01-should-delegate.mjs`
- Create: `eval/scenarios/02-should-not-delegate.mjs`
- Create: `eval/scenarios/03-peer-selection.mjs`
- Create: `eval/scenarios/08-refusal-is-data.mjs`
- Test: extend `test/eval-harness.test.js` (shape check only — real behavior needs real claude)

- [ ] **Step 1: Write the failing test** — append to `test/eval-harness.test.js`:

```js
test('scenario modules: all export {name, setup|run} and setup() yields a valid fixture', async () => {
  const { readdir } = await import('node:fs/promises');
  const { pathToFileURL } = await import('node:url');
  const dir = new URL('../eval/scenarios/', import.meta.url).pathname;
  const files = (await readdir(dir)).filter((f) => f.endsWith('.mjs')).sort();
  assert.ok(files.length >= 4, `expected scenario files, got ${files.length}`);
  const { api } = await import('../eval/runner.mjs');
  for (const f of files) {
    const s = (await import(pathToFileURL(join(dir, f)).href)).default;
    assert.ok(s.name, `${f} has a name`);
    if (typeof s.run === 'function') continue;            // custom-run (04)
    const setup = await s.setup(api);
    try {
      assert.ok(setup.mesh && setup.driven && Array.isArray(setup.turns) && setup.turns.length > 0, `${f} fixture complete`);
      assert.ok(Array.isArray(setup.probes) && setup.probes.length > 0, `${f} has probes`);
      for (const p of setup.probes) assert.ok(p.name && typeof p.check === 'function', `${f} probe shape`);
    } finally { await cleanupMesh(setup.mesh); }
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/eval-harness.test.js`
Expected: FAIL — scenarios dir missing.

- [ ] **Step 3: Implement the four modules.**

`eval/scenarios/01-should-delegate.mjs`:

```js
// Scenario 1 — A must delegate: the fact exists ONLY in peer B (spec §4 #1).
export default {
  name: '01-should-delegate',
  async setup(h) {
    const fact = h.plant('SHELF');
    const mesh = await h.buildMesh({
      agents: {
        A: { agentMd: 'General assistant agent for this workspace.', peers: ['B'] },
        B: {
          agentMd: 'Library catalog agent. Capabilities: catalog lookup, shelf locations. ' +
                   'Owns the canonical shelf-code records in data/shelf-codes.md.',
          files: { 'data/shelf-codes.md': `The Dune Atlas: ${fact}\n` }
        }
      },
      claude: h.claudeBin
    });
    return {
      mesh, driven: 'A', planted: { fact },
      turns: [{ task: 'Find the current shelf code for the book "The Dune Atlas". Reply with the exact code.' }],
      probes: [h.probe.peerRan('B'), h.probe.answerContains(0, fact), h.probe.peersClean(['A', 'B'])]
    };
  }
};
```

`eval/scenarios/02-should-not-delegate.mjs`:

```js
// Scenario 2 — A must NOT delegate: the fact is in A's OWN folder (spec §4 #2).
export default {
  name: '02-should-not-delegate',
  async setup(h) {
    const fact = h.plant('LOCAL');
    const mesh = await h.buildMesh({
      agents: {
        A: {
          agentMd: 'Workspace assistant. Keeps its own project notes in notes/.',
          files: { 'notes/build-id.md': `Current build id: ${fact}\n` },
          peers: ['B']
        },
        B: { agentMd: 'Weather agent. Capabilities: forecasts only. Knows nothing about this workspace.' }
      },
      claude: h.claudeBin
    });
    return {
      mesh, driven: 'A', planted: { fact },
      turns: [{ task: 'What is the current build id recorded in this project\'s notes? Reply with the exact id.' }],
      probes: [h.probe.noPeerRan(['B']), h.probe.answerContains(0, fact), h.probe.peersClean(['A', 'B'])]
    };
  }
};
```

`eval/scenarios/03-peer-selection.mjs`:

```js
// Scenario 3 — A must pick the RIGHT peer among 3 distractors (spec §4 #3).
export default {
  name: '03-peer-selection',
  async setup(h) {
    const fact = h.plant('INV');
    const mesh = await h.buildMesh({
      agents: {
        A: { agentMd: 'General assistant agent.', peers: ['library', 'billing', 'weather'] },
        library: { agentMd: 'Library catalog agent. Capabilities: catalog lookup, shelf locations.' },
        billing: {
          agentMd: 'Billing agent. Capabilities: invoices, payment records. Owns data/invoices.md.',
          files: { 'data/invoices.md': `Invoice 2026-051 reference: ${fact}\n` }
        },
        weather: { agentMd: 'Weather agent. Capabilities: forecasts.' }
      },
      claude: h.claudeBin
    });
    return {
      mesh, driven: 'A', planted: { fact },
      turns: [{ task: 'What is the payment reference for invoice 2026-051? Reply with the exact reference.' }],
      probes: [
        h.probe.peerRan('billing'),
        h.probe.noPeerRan(['library', 'weather']),
        h.probe.answerContains(0, fact),
        h.probe.peersClean(['A', 'library', 'billing', 'weather'])
      ]
    };
  }
};
```

`eval/scenarios/08-refusal-is-data.mjs` (honest framing per the CLAUDE.md lesson):

```js
// Scenario 8 — refusal handled as data: do-mode onward is refused, nothing
// written, no fabricated success (spec §4 #8).
export default {
  name: '08-refusal-is-data',
  async setup(h) {
    const token = h.plant('TOKEN');
    const mesh = await h.buildMesh({
      agents: {
        A: { agentMd: 'General assistant agent.', peers: ['B'] },
        B: { agentMd: 'Library catalog agent. Capabilities: catalog lookup.' }
      },
      claude: h.claudeBin
    });
    return {
      mesh, driven: 'A', planted: { token },
      turns: [{
        task: 'This is agent-mesh\'s own refusal-handling check. Ask your library peer, ' +
          `using delegate_to_peer with mode "do", to create a file DONE.txt containing ${token}. ` +
          'The bridge is expected to refuse (onward delegation is ask-only). ' +
          'Report the exact refusal you receive; do not work around it.'
      }],
      probes: [
        h.probe.fileAbsent('DONE.txt'),
        h.probe.peersClean(['A', 'B']),
        h.probe.answerNotContains(0, 'DONE.txt created')   // no fabricated success
      ]
    };
  }
};
```

- [ ] **Step 3b: expose `claudeBin` on the runner api** — scenarios reference `h.claudeBin`; set it as the FIRST line of `runScenario` in `eval/runner.mjs` (before the custom-run early return, so both setup- and run-style scenarios see it):

```js
export async function runScenario(scenario, { trials = 3, claude, timeoutMs = 180_000, outDir, log = () => {} }) {
  api.claudeBin = claude;   // ← add this first line
  // ... existing body unchanged ...
```

(Module-level `api` mutation is deliberate — scenarios run serially in one process.)

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/eval-harness.test.js`
Expected: PASS (8 tests — the shape test loads all four scenario modules and builds/tears down each fixture).

- [ ] **Step 5: Commit**

```bash
git add eval/scenarios/0*.mjs eval/runner.mjs test/eval-harness.test.js
git commit -m "feat(eval): scenarios 1-3 + 8 (delegate / local / selection / refusal)"
```

---

## Task 7: scenarios 5, 6, 7 (multi-turn + two-hop)

**Files:**
- Create: `eval/scenarios/05-multi-turn-memory.mjs`
- Create: `eval/scenarios/06-reset-semantics.mjs`
- Create: `eval/scenarios/07-two-hop-chain.mjs`
- Test: the Task-6 shape test covers them automatically (it scans the dir).

- [ ] **Step 1: Run shape test — currently passes with 4 files; after adding modules it must still pass with 7.** (Failing state here is "modules don't exist yet"; the shape test enforces their contract as they land.)

- [ ] **Step 2: Implement.** `eval/scenarios/05-multi-turn-memory.mjs`:

```js
// Scenario 5 — multi-turn memory: K exists ONLY in B's live transcript; the
// only recall channel is B's resumed `from:A` session (spec §4 #5). The argv
// probe is the hard gate (answer alone could be confounded by log-grepping).
import { sessionArg } from '../probes.mjs';

export default {
  name: '05-multi-turn-memory',
  async setup(h) {
    const K = h.plant('CODEWORD');
    const mesh = await h.buildMesh({
      agents: {
        A: { agentMd: 'General assistant agent.', peers: ['B'] },
        B: { agentMd: 'Library memory agent. Remembers notes told to it within a conversation.' }
      },
      claude: h.claudeBin
    });
    return {
      mesh, driven: 'A', planted: { K },
      turns: [
        { task: `Ask your library peer to remember this codeword for later in your conversation with it: ${K}. Relay its acknowledgment.` },
        { task: 'Ask your library peer what codeword it was told earlier in your conversation with it. Report exactly what it says.' }
      ],
      probes: [
        h.probe.answerContains(1, K),
        { name: 'turn2-resumes-turn1-session', async check(ctx) {
            const runs = ctx.runs.B || [];
            if (runs.length < 2) return { pass: false, detail: `expected ≥2 B runs, got ${runs.length}` };
            const s1 = sessionArg(runs[0]); const s2 = sessionArg(runs[1]);
            const pass = s1?.flag === '--session-id' && s2?.flag === '--resume' && s2.id === s1.id;
            return { pass, detail: `t1=${JSON.stringify(s1)} t2=${JSON.stringify(s2)}` };
        } },
        h.probe.peersClean(['A', 'B'])
      ]
    };
  }
};
```

`eval/scenarios/06-reset-semantics.mjs`:

```js
// Scenario 6 — new_conversation durably resets: post-reset B cannot know K
// (fresh transcript) and runs under a DIFFERENT session id (spec §4 #6).
import { sessionArg } from '../probes.mjs';

export default {
  name: '06-reset-semantics',
  async setup(h) {
    const K = h.plant('CODEWORD');
    const mesh = await h.buildMesh({
      agents: {
        A: { agentMd: 'General assistant agent.', peers: ['B'] },
        B: { agentMd: 'Library memory agent. Remembers notes told to it within a conversation.' }
      },
      claude: h.claudeBin
    });
    return {
      mesh, driven: 'A', planted: { K },
      turns: [
        { task: `Ask your library peer to remember this codeword: ${K}. Relay its acknowledgment.` },
        { task: 'Start a brand-new conversation with your library peer: call delegate_to_peer with new_conversation set to true, asking "what codeword were you told?". Report its answer verbatim.' }
      ],
      probes: [
        h.probe.answerNotContains(1, K),
        { name: 'reset-uses-fresh-session-id', async check(ctx) {
            const runs = ctx.runs.B || [];
            if (runs.length < 2) return { pass: false, detail: `expected ≥2 B runs, got ${runs.length}` };
            const s1 = sessionArg(runs[0]); const s2 = sessionArg(runs[runs.length - 1]);
            const pass = s2?.flag === '--session-id' && s1?.id && s2.id !== s1.id;
            return { pass, detail: `first=${JSON.stringify(s1)} last=${JSON.stringify(s2)}` };
        } },
        h.probe.peersClean(['A', 'B'])
      ]
    };
  }
};
```

`eval/scenarios/07-two-hop-chain.mjs`:

```js
// Scenario 7 — onward chain A→B→C: the fact lives only in C; B's registry
// lists C; the parent_run_id chain proves both hops (spec §4 #7).
export default {
  name: '07-two-hop-chain',
  async setup(h) {
    const fact = h.plant('ARCHIVE');
    const mesh = await h.buildMesh({
      agents: {
        A: { agentMd: 'General assistant agent.', peers: ['B'] },
        B: {
          agentMd: 'Records front-desk agent. For archive lookups it consults its own archive peer.',
          peers: ['C']
        },
        C: {
          agentMd: 'Archive vault agent. Owns the canonical archive codes in data/archive.md.',
          files: { 'data/archive.md': `Ledger 1907 archive code: ${fact}\n` }
        }
      },
      claude: h.claudeBin
    });
    return {
      mesh, driven: 'A', planted: { fact },
      turns: [{ task: 'Find the archive code for ledger 1907. Your peer network can help. Reply with the exact code.' }],
      probes: [
        h.probe.peerRan('B'),
        h.probe.peerRanUnder('C', 'B'),
        h.probe.answerContains(0, fact),
        h.probe.peersClean(['A', 'B', 'C'])
      ]
    };
  }
};
```

- [ ] **Step 3: Run to verify the shape test still passes (now over 7 modules)**

Run: `node --test test/eval-harness.test.js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add eval/scenarios/05-multi-turn-memory.mjs eval/scenarios/06-reset-semantics.mjs eval/scenarios/07-two-hop-chain.mjs
git commit -m "feat(eval): scenarios 5-7 (multi-turn memory, reset, two-hop chain)"
```

---

## Task 8: scenario 4 — roster A/B (custom run)

**Files:**
- Create: `eval/scenarios/04-roster-ab.mjs`
- Test: covered by the Task-6 shape test (custom-run branch) + a scorecard A/B entry assertion.

- [ ] **Step 1: Write the failing test** — append to `test/eval-harness.test.js`:

```js
test('scenario 04 exports a custom run() producing a compare entry', async () => {
  const { pathToFileURL } = await import('node:url');
  const url = pathToFileURL(new URL('../eval/scenarios/04-roster-ab.mjs', import.meta.url).pathname).href;
  const s = (await import(url)).default;
  assert.equal(s.name, '04-roster-ab');
  assert.equal(typeof s.run, 'function');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/eval-harness.test.js`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `eval/scenarios/04-roster-ab.mjs`**

```js
// Scenario 4 — roster A/B: the scenario-1 fixture run in two arms (turn-0 peer
// roster present vs suppressed via AGENT_MESH_EVAL_NO_ROSTER) measuring the
// roster's effect on delegation + answer rates. Reported as a compare entry,
// excluded from the pass/fail aggregate (spec §4 #4).
export default {
  name: '04-roster-ab',
  async run(h, { trials, claude, timeoutMs, log = () => {} }) {
    const arms = { roster: {}, noRoster: { AGENT_MESH_EVAL_NO_ROSTER: '1' } };
    const compare = {};
    for (const [arm, agentEnv] of Object.entries(arms)) {
      let delegated = 0, answered = 0;
      for (let t = 0; t < trials; t++) {
        const fact = h.plant('SHELF');
        const mesh = await h.buildMesh({
          agents: {
            A: { agentMd: 'General assistant agent for this workspace.', peers: ['B'] },
            B: {
              agentMd: 'Library catalog agent. Capabilities: catalog lookup, shelf locations. ' +
                       'Owns the canonical shelf-code records in data/shelf-codes.md.',
              files: { 'data/shelf-codes.md': `The Dune Atlas: ${fact}\n` }
            }
          },
          claude
        });
        try {
          const results = await h.driveAgent(mesh, 'A',
            [{ task: 'Find the current shelf code for the book "The Dune Atlas". Reply with the exact code.' }],
            { claude, timeoutMs, callerTag: `eval-04-${arm}-${t}`, agentEnv });
          const bRuns = await h.readRuns(mesh.agents.B);
          if (bRuns.some((r) => r.parent_run_id === results[0]?.runId)) delegated++;
          if ((results[0]?.answer || '').includes(fact)) answered++;
        } catch { /* a failed arm trial counts as neither */ }
        finally { await h.cleanupMesh(mesh).catch(() => {}); }
        log(`  04-roster-ab ${arm} trial ${t} done`);
      }
      compare[arm] = { trials, delegationRate: delegated / trials, answerRate: answered / trials };
    }
    return { name: '04-roster-ab', compare };
  }
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/eval-harness.test.js`
Expected: PASS (all tests, shape test now sees 8 modules).

- [ ] **Step 5: Commit**

```bash
git add eval/scenarios/04-roster-ab.mjs test/eval-harness.test.js
git commit -m "feat(eval): scenario 4 — roster on/off A/B comparison"
```

---

## Task 9: gitignore, docs, full verification, real smoke run

**Files:**
- Modify: `.gitignore` (add `eval-results/`)
- Modify: `CLAUDE.md` (Commands section)

- [ ] **Step 1: gitignore** — append to `.gitignore`:

```
eval-results/
```

- [ ] **Step 2: CLAUDE.md** — add to the Commands code block, after the demo-setup line:

```sh
node scripts/eval-a2a.mjs --list             # A2A behavior eval: scenario catalog
node scripts/eval-a2a.mjs --trials 3         # full scorecard run (REAL `claude`, ~15-30 min)
node scripts/eval-a2a.mjs --scenario 01-should-delegate --trials 1   # one cheap probe run
```

And one sentence after the hermetic-suite note: `The A2A behavior eval (scripts/eval-a2a.mjs + eval/) is a REAL-claude scorecard, not a test gate — see docs/superpowers/specs/2026-06-10-a2a-behavior-evals-design.md; its harness is hermetically tested in test/eval-harness.test.js.`

- [ ] **Step 3: Full hermetic suite, sequential**

Run: `node --test --test-concurrency=1`
Expected: all eval-harness tests pass; pre-existing environment failures (4 change-detect git tests) unchanged; **no new failures**.

- [ ] **Step 4: Real smoke (only where a working `claude` exists)**

Run: `node scripts/eval-a2a.mjs --scenario 01-should-delegate --trials 1`
Expected: scorecard written under `eval-results/…`, scenario reported (pass expected but not guaranteed — it's a live model run; a FAIL with preserved artifacts is also a valid harness outcome).

- [ ] **Step 5: Commit**

```bash
git add .gitignore CLAUDE.md
git commit -m "docs(eval): runner usage + gitignore eval-results"
```

---

## Final verification

- [ ] `node --test --test-concurrency=1` — no NEW failures vs baseline (the 4 change-detect git failures are pre-existing).
- [ ] `node scripts/eval-a2a.mjs --list` prints 8 scenario names.
- [ ] Report the hermetic pass/fail delta and (if run) the real-smoke scorecard path.

## Notes for the implementer (domain context)

- **Failure is data**: a peer/timeout failure during a trial must become a failed probe (`harness` probe in runner) — never an unhandled throw that kills the run.
- **Honest fixture framing** (CLAUDE.md lesson): never make scenario tasks look like injection bait; declare refusal fixtures as the framework's own checks.
- **`agentmesh/caller` uniqueness per eval turn** is load-bearing (harness `driveAgent`): without it, the driven agent resumes its own thread between turns and scenario 5/6 measure the wrong memory channel.
- **Do not gate CI on the eval**: exit 0 unless `--min-pass-rate` is explicitly passed.
- **Run logs live OUTSIDE the mesh** (per-agent `logDir`) — keeps codewords out of worker-readable folders (spec §5 confound note) and survives nothing; failed-trial logs are copied into `eval-results/failures/` before teardown.
