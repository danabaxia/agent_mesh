import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { createMeshHealth } from '../src/mesh-health/core.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

async function makeMesh(t, agents = [{ name: 'alpha', root: './alpha' }]) {
  const meshRoot = await mkdtemp(join(tmpdir(), 'mesh-health-'));
  // maxRetries: a just-killed child's cwd handle can outlive taskkill on
  // Windows (EDR-slowed kills) — retry EBUSY instead of failing the test.
  t.after(() => rm(meshRoot, { recursive: true, force: true, maxRetries: 30, retryDelay: 500 }));
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

test('triage_logs rejects garbage since_hours as error data', async (t) => {
  const meshRoot = await makeMesh(t);
  const health = createMeshHealth({ meshRoot });
  for (const bad of ['abc', 0, -5, NaN, {}]) {
    const out = await health.triageLogs({ since_hours: bad });
    assert.equal(out.error, 'bad_input: since_hours', `since_hours=${String(bad)}`);
  }
});

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
  // maxRetries: a just-killed child's cwd handle can outlive taskkill on
  // Windows (EDR-slowed kills) — retry EBUSY instead of failing the test.
  t.after(() => rm(meshRoot, { recursive: true, force: true, maxRetries: 30, retryDelay: 500 }));
  const health = createMeshHealth({ meshRoot });
  const out = await health.checkConformance();
  assert.equal(out.ok, false);
  assert.ok(out.error);
});

test('check_conformance reports ok on a conformant mesh', async (t) => {
  const meshRoot = await makeMesh(t);
  const alpha = join(meshRoot, 'alpha');
  await writeFile(join(alpha, 'agent.json'), JSON.stringify({
    name: 'alpha',
    description: 'Test agent',
    protocolVersion: '0.3.0',
    version: '0.1.0',
    skills: [],
    'x-agentmesh': { modes: ['ask'], meshVersion: '0.1.0' }
  }, null, 2));
  await mkdir(join(alpha, 'prompts'), { recursive: true });
  await writeFile(join(alpha, 'prompts', 'system.md'), '# alpha\n\nYou are a test agent.\n');
  const { CANONICAL_DIRS } = await import('../src/builder/scaffold.js');
  for (const dir of CANONICAL_DIRS) await mkdir(join(alpha, dir), { recursive: true });
  const health = createMeshHealth({ meshRoot });
  const out = await health.checkConformance();
  assert.equal(out.error, undefined);
  assert.equal(out.counts.fail, 0);
  assert.equal(out.ok, true);
  assert.deepEqual(out.problems.filter((p) => p.level === 'fail'), []);
});

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
  // Bound: pingTimeoutMs (500) + backstop (KILL_ESCALATION_MS=2000 + 3000) + headroom.
  assert.ok(Date.now() - started < 8_000, 'must not wait beyond the timeout');
});

test('ping_agent crash: an instantly-exiting server fails fast as probe_failed', async (t) => {
  const meshRoot = await makeMesh(t);
  const crashBin = join(meshRoot, 'crash.mjs');
  await writeFile(crashBin, 'console.error("boom: bad card");\nprocess.exit(1);\n');
  const health = createMeshHealth({
    meshRoot,
    binPath: crashBin,
    env: { ...process.env, AGENT_MESH_HEALTH_PING_TIMEOUT_MS: '10000' }
  });
  const started = Date.now();
  const out = await health.pingAgent({ name: 'alpha' });
  assert.equal(out.alive, false);
  assert.match(out.error, /^probe_failed: exited code=1/);
  assert.match(out.error, /boom: bad card/);
  assert.ok(Date.now() - started < 5_000, 'crash must be detected fast, not wait out the 10s timeout');
});

// ---------------------------------------------------------------------------
// list_stale_tasks
// ---------------------------------------------------------------------------

async function makeTask(meshRoot, { id = 'a-b-001', from = 'a', to = 'b', state = 'assigned', lastAt = null } = {}) {
  const { mkdir: mkd, writeFile: wf } = await import('node:fs/promises');
  const tasksDir = join(meshRoot, 'mesh', 'board', 'tasks');
  await mkd(tasksDir, { recursive: true });
  const at = lastAt ?? new Date().toISOString();
  const task = {
    id, from, to, title: 'test', objective: 'do X', context: '', requirements: 'Y', pointers: '',
    state,
    created_at: at,
    result: null,
    seen_by_from: false,
    history: [{ state, at, by: from }]
  };
  const { join: pjoin } = await import('node:path');
  await wf(pjoin(tasksDir, `${id}.json`), JSON.stringify(task, null, 2) + '\n');
  return task;
}

test('listStaleTasks returns stale non-terminal tasks', async (t) => {
  const meshRoot = await makeMesh(t);
  const oldAt = new Date(Date.now() - 10_000).toISOString(); // 10 s ago
  await makeTask(meshRoot, { id: 'a-b-001', state: 'assigned', lastAt: oldAt });
  await makeTask(meshRoot, { id: 'a-b-002', state: 'in-progress', lastAt: oldAt });

  const health = createMeshHealth({ meshRoot });
  const out = await health.listStaleTasks({ stale_ms: 5_000 }); // 5 s threshold → both stale

  assert.equal(out.error, undefined);
  assert.equal(out.stale_ms, 5_000);
  assert.equal(out.tasks.length, 2);
  assert.ok(out.tasks.every((t2) => t2.age_ms >= 5_000));
  assert.ok(out.tasks.every((t2) => ['assigned', 'in-progress'].includes(t2.state)));
});

test('listStaleTasks excludes done tasks', async (t) => {
  const meshRoot = await makeMesh(t);
  const oldAt = new Date(Date.now() - 10_000).toISOString();
  await makeTask(meshRoot, { id: 'a-b-001', state: 'done', lastAt: oldAt });

  const health = createMeshHealth({ meshRoot });
  const out = await health.listStaleTasks({ stale_ms: 1 });

  assert.equal(out.error, undefined);
  assert.equal(out.tasks.length, 0);
});

test('listStaleTasks excludes fresh tasks', async (t) => {
  const meshRoot = await makeMesh(t);
  // lastAt = now, so age_ms ≈ 0 — below the 1-hour threshold
  await makeTask(meshRoot, { id: 'a-b-001', state: 'assigned' });

  const health = createMeshHealth({ meshRoot });
  const out = await health.listStaleTasks({ stale_ms: 3_600_000 });

  assert.equal(out.error, undefined);
  assert.equal(out.tasks.length, 0);
});

test('listStaleTasks returns empty when board dir is absent', async (t) => {
  const meshRoot = await makeMesh(t);
  const health = createMeshHealth({ meshRoot });
  const out = await health.listStaleTasks({ stale_ms: 1 });
  assert.equal(out.error, undefined);
  assert.deepEqual(out.tasks, []);
});

test('listStaleTasks rejects bad stale_ms as error data', async (t) => {
  const meshRoot = await makeMesh(t);
  const health = createMeshHealth({ meshRoot });
  for (const bad of [0, -1, 'abc', NaN]) {
    const out = await health.listStaleTasks({ stale_ms: bad });
    assert.equal(out.error, 'bad_input: stale_ms', `stale_ms=${String(bad)}`);
  }
});

test('listStaleTasks respects env AGENT_MESH_BOARD_STALE_MS default', async (t) => {
  const meshRoot = await makeMesh(t);
  const oldAt = new Date(Date.now() - 2_000).toISOString(); // 2 s ago
  await makeTask(meshRoot, { id: 'a-b-001', state: 'acknowledged', lastAt: oldAt });

  // env default of 1 s → task is stale; without override it uses DEFAULT_BOARD_STALE_MS (24 h) → not stale
  const health = createMeshHealth({ meshRoot, env: { ...process.env, AGENT_MESH_BOARD_STALE_MS: '1000' } });
  const out = await health.listStaleTasks();

  assert.equal(out.error, undefined);
  assert.equal(out.stale_ms, 1_000);
  assert.equal(out.tasks.length, 1);
  assert.equal(out.tasks[0].state, 'acknowledged');
});

// ---------------------------------------------------------------------------
// stdio MCP wire (serve-mesh-health)
// ---------------------------------------------------------------------------

const BIN = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agent-mesh.js');

function wireClient(child) {
  let buf = '';
  const waiters = new Map();
  let dead = null;
  child.on('close', (code) => {
    dead = new Error(`server exited code=${code}`);
    for (const [, w] of waiters) w.reject(dead);
    waiters.clear();
  });
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id && waiters.has(msg.id)) { waiters.get(msg.id).resolve(msg); waiters.delete(msg.id); }
    }
  });
  let id = 0;
  return (method, params) => new Promise((resolve, reject) => {
    if (dead) return reject(dead);
    const myId = ++id;
    waiters.set(myId, { resolve, reject });
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
  assert.deepEqual(names, ['check_conformance', 'list_stale_tasks', 'ping_agent', 'triage_logs']);

  const triage = await call('tools/call', { name: 'triage_logs', arguments: { since_hours: 1 } });
  const payload = JSON.parse(triage.result.content[0].text);
  assert.equal(payload.agents.length, 1);

  const bad = await call('tools/call', { name: 'nope', arguments: {} });
  assert.ok(bad.error);
});
