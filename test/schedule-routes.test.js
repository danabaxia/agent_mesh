/**
 * test/schedule-routes.test.js — Phase-5 Task 3: schedule endpoints.
 *
 *   GET    /api/agent/:name/schedule             → defs ⨯ state rows (+ cadenceLabel)
 *   POST   /api/agent/:name/schedule             → create def (201 {id})
 *   POST   /api/agent/:name/schedule/:id/run     → 202, fires scheduler.runNow
 *   POST   /api/agent/:name/schedule/:id/enable  → 200, scheduler.setEnabled
 *   DELETE /api/agent/:name/schedule/:id         → remove def (+ state entry)
 *
 * GET works even without a scheduler (read-only defs, schedulerEnabled:false);
 * every mutating route is 403 scheduler_disabled when the shell gate is off
 * and no scheduler was injected. Harness mirrors test/artifact-routes.test.js:
 * temp mesh + library agent, token-boot → cookie auth, same-origin fetch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardServer } from '../src/dashboard/server.js';
import { initMesh } from '../src/builder/init-mesh.js';
import { writeManifest } from '../src/builder/manifest.js';

async function buildMesh() {
  const meshRoot = await mkdtemp(join(tmpdir(), 'schedroutes-'));
  await initMesh(meshRoot);
  const agentRoot = join(meshRoot, 'library');
  await mkdir(agentRoot, { recursive: true });
  await writeFile(join(agentRoot, 'agent.json'), JSON.stringify({ name: 'library' }), 'utf8');
  await writeManifest(meshRoot, { meshVersion: '0.1.0', agents: [{ name: 'library', root: './library', card: 'agent.json', served: true, enabledModes: ['ask'], peers: [] }] });
  return { meshRoot, agentRoot };
}

// Seed job definitions: <agentRoot>/.agent/schedule.json (Phase-5 contract).
async function seedSchedule(agentRoot, jobs) {
  await mkdir(join(agentRoot, '.agent'), { recursive: true });
  await writeFile(join(agentRoot, '.agent', 'schedule.json'), JSON.stringify({ jobs }, null, 2) + '\n', 'utf8');
}

const readDefs = async (agentRoot) =>
  JSON.parse(await readFile(join(agentRoot, '.agent', 'schedule.json'), 'utf8'));

// Recording stub scheduler injected via createDashboardServer({ scheduler }).
function stubScheduler(rows = []) {
  const calls = { runNow: [], setEnabled: [] };
  const scheduler = {
    start() {}, stop() {},
    tick: async () => {},
    runNow: async (...a) => { calls.runNow.push(a); return { ok: true }; },
    setEnabled: async (...a) => { calls.setEnabled.push(a); return { ok: true }; },
    list: async (agent) => rows.map((r) => ({ ...r, _listedFor: agent }))
  };
  return { scheduler, calls };
}

async function authed(meshRoot, opts = {}) {
  const srv = createDashboardServer({ meshRoot, port: 0, ...opts });
  await srv.start(); const port = new URL(srv.url).port;
  const boot = await fetch(`${srv.url}/?t=${srv.token}`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'none' }, redirect: 'manual' });
  const cookie = `am_dash=${boot.headers.get('set-cookie').match(/am_dash=([^;]+)/)[1]}`;
  return { srv, port, cookie };
}
const get = (srv, port, cookie, p) => fetch(`${srv.url}${p}`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie } });
const post = (srv, port, cookie, p, body) => fetch(`${srv.url}${p}`, {
  method: 'POST',
  headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify(body ?? {})
});
const del = (srv, port, cookie, p) => fetch(`${srv.url}${p}`, {
  method: 'DELETE',
  headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie }
});

const dailyJob = (over = {}) => ({
  id: 'hub-refresh', name: 'Hub refresh', prompt: 'do x',
  cadence: { kind: 'daily', at: '07:00' }, enabled: true, saveArtifact: false, ...over
});

// ---------------------------------------------------------------------------
// No scheduler (default server opts — shell gate off)
// ---------------------------------------------------------------------------

test('schedule GET without scheduler → 200 read-only defs, schedulerEnabled:false', async () => {
  const { meshRoot, agentRoot } = await buildMesh();
  await seedSchedule(agentRoot, [
    dailyJob(),
    { id: 'weekly-sweep', name: 'Weekly sweep', prompt: 'sweep', cadence: { kind: 'weekly', day: 'mon', at: '06:30' }, enabled: false, saveArtifact: true }
  ]);
  const { srv, port, cookie } = await authed(meshRoot);
  try {
    const r = await get(srv, port, cookie, '/api/agent/library/schedule');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.schedulerEnabled, false);
    assert.equal(body.jobs.length, 2);
    const [a, b] = body.jobs;
    assert.equal(a.id, 'hub-refresh');
    assert.equal(a.name, 'Hub refresh');
    assert.deepEqual(a.cadence, { kind: 'daily', at: '07:00' });
    assert.equal(a.enabled, true);
    assert.equal(a.cadenceLabel, 'daily · 07:00');
    assert.equal(a.lastRunAt ?? null, null, 'no runtime state without a scheduler');
    assert.equal(a.lastStatus ?? null, null);
    assert.equal(a.nextRunAt ?? null, null);
    assert.equal(b.id, 'weekly-sweep');
    assert.equal(b.enabled, false);
    assert.equal(b.cadenceLabel, 'weekly · mon 06:30');
  } finally { await srv.close(); }
});

test('schedule GET without scheduler: no schedule.json → 200 empty; unknown agent → 404', async () => {
  const { meshRoot } = await buildMesh();
  const { srv, port, cookie } = await authed(meshRoot);
  try {
    const r = await get(srv, port, cookie, '/api/agent/library/schedule');
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).jobs, []);
    assert.equal((await get(srv, port, cookie, '/api/agent/no-such-agent/schedule')).status, 404);
  } finally { await srv.close(); }
});

test('schedule mutations without scheduler → 403 scheduler_disabled', async () => {
  const { meshRoot, agentRoot } = await buildMesh();
  await seedSchedule(agentRoot, [dailyJob({ id: 'x', name: 'x' })]);
  const { srv, port, cookie } = await authed(meshRoot);
  try {
    const attempts = [
      post(srv, port, cookie, '/api/agent/library/schedule', { name: 'n', prompt: 'p', cadence: { kind: 'daily', at: '07:00' } }),
      post(srv, port, cookie, '/api/agent/library/schedule/x/run'),
      post(srv, port, cookie, '/api/agent/library/schedule/x/enable', { enabled: false }),
      del(srv, port, cookie, '/api/agent/library/schedule/x')
    ];
    for (const r of await Promise.all(attempts)) {
      assert.equal(r.status, 403);
      const body = await r.json();
      assert.equal(body.error.code, 'scheduler_disabled');
    }
  } finally { await srv.close(); }
});

// ---------------------------------------------------------------------------
// Injected stub scheduler
// ---------------------------------------------------------------------------

test('schedule GET with scheduler → scheduler.list passthrough + schedulerEnabled:true', async () => {
  const { meshRoot } = await buildMesh();
  const rows = [dailyJob({ lastRunAt: '2026-06-11T07:00:00.000Z', lastStatus: 'ok', lastSummary: 'fine', nextRunAt: '2026-06-12T07:00:00.000Z', running: false })];
  const { scheduler } = stubScheduler(rows);
  const { srv, port, cookie } = await authed(meshRoot, { scheduler });
  try {
    const r = await get(srv, port, cookie, '/api/agent/library/schedule');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.schedulerEnabled, true);
    assert.equal(body.jobs.length, 1);
    const job = body.jobs[0];
    assert.equal(job._listedFor, 'library', 'rows come from scheduler.list(name)');
    assert.equal(job.lastStatus, 'ok');
    assert.equal(job.nextRunAt, '2026-06-12T07:00:00.000Z');
    assert.equal(job.cadenceLabel, 'daily · 07:00', 'describeCadence applied server-side');
  } finally { await srv.close(); }
});

test('schedule POST → 201 {id:slug}, def appended with enabled:true/saveArtifact:false defaults; name collision → -2', async () => {
  const { meshRoot, agentRoot } = await buildMesh();
  const { scheduler } = stubScheduler();
  const { srv, port, cookie } = await authed(meshRoot, { scheduler });
  try {
    const r = await post(srv, port, cookie, '/api/agent/library/schedule', {
      name: 'Hub refresh', prompt: 'do x', cadence: { kind: 'daily', at: '07:00' }
    });
    assert.equal(r.status, 201);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.id, 'hub-refresh');

    const defs = await readDefs(agentRoot);
    assert.equal(defs.jobs.length, 1);
    assert.deepEqual(defs.jobs[0], {
      id: 'hub-refresh', name: 'Hub refresh', prompt: 'do x',
      cadence: { kind: 'daily', at: '07:00' }, enabled: true, saveArtifact: false
    });

    const r2 = await post(srv, port, cookie, '/api/agent/library/schedule', {
      name: 'Hub refresh', prompt: 'do y', cadence: { kind: 'every', minutes: 30 }, saveArtifact: true
    });
    assert.equal(r2.status, 201);
    assert.equal((await r2.json()).id, 'hub-refresh-2');
    const defs2 = await readDefs(agentRoot);
    assert.equal(defs2.jobs.length, 2);
    assert.equal(defs2.jobs[1].saveArtifact, true);
  } finally { await srv.close(); }
});

test('schedule POST validation: junk cadence → 400; missing name/prompt → 400; unknown agent → 404', async () => {
  const { meshRoot } = await buildMesh();
  const { scheduler } = stubScheduler();
  const { srv, port, cookie } = await authed(meshRoot, { scheduler });
  try {
    const ok = { name: 'n', prompt: 'p', cadence: { kind: 'daily', at: '07:00' } };
    assert.equal((await post(srv, port, cookie, '/api/agent/library/schedule', { ...ok, cadence: { kind: 'hourly' } })).status, 400);
    assert.equal((await post(srv, port, cookie, '/api/agent/library/schedule', { ...ok, cadence: { kind: 'every', minutes: 1 } })).status, 400);
    assert.equal((await post(srv, port, cookie, '/api/agent/library/schedule', { ...ok, cadence: 'daily' })).status, 400);
    assert.equal((await post(srv, port, cookie, '/api/agent/library/schedule', { prompt: 'p', cadence: ok.cadence })).status, 400);
    assert.equal((await post(srv, port, cookie, '/api/agent/library/schedule', { ...ok, name: '   ' })).status, 400);
    assert.equal((await post(srv, port, cookie, '/api/agent/library/schedule', { name: 'n', cadence: ok.cadence })).status, 400);
    assert.equal((await post(srv, port, cookie, '/api/agent/library/schedule', { ...ok, prompt: '' })).status, 400);
    assert.equal((await post(srv, port, cookie, '/api/agent/no-such-agent/schedule', ok)).status, 404);
  } finally { await srv.close(); }
});

test('schedule run → 202 + scheduler.runNow(name,id); unknown id → 404', async () => {
  const { meshRoot, agentRoot } = await buildMesh();
  await seedSchedule(agentRoot, [dailyJob()]);
  const { scheduler, calls } = stubScheduler();
  const { srv, port, cookie } = await authed(meshRoot, { scheduler });
  try {
    const r = await post(srv, port, cookie, '/api/agent/library/schedule/hub-refresh/run');
    assert.equal(r.status, 202);
    assert.deepEqual(await r.json(), { ok: true });
    assert.deepEqual(calls.runNow, [['library', 'hub-refresh']]);

    assert.equal((await post(srv, port, cookie, '/api/agent/library/schedule/no-such-job/run')).status, 404);
    assert.equal(calls.runNow.length, 1, 'runNow not fired for an unknown job');
  } finally { await srv.close(); }
});

test('schedule enable → 200 + scheduler.setEnabled(name,id,bool); non-boolean → 400; unknown id → 404', async () => {
  const { meshRoot, agentRoot } = await buildMesh();
  await seedSchedule(agentRoot, [dailyJob()]);
  const { scheduler, calls } = stubScheduler();
  const { srv, port, cookie } = await authed(meshRoot, { scheduler });
  try {
    const r = await post(srv, port, cookie, '/api/agent/library/schedule/hub-refresh/enable', { enabled: false });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
    assert.deepEqual(calls.setEnabled, [['library', 'hub-refresh', false]]);

    assert.equal((await post(srv, port, cookie, '/api/agent/library/schedule/hub-refresh/enable', { enabled: 'nope' })).status, 400);
    assert.equal((await post(srv, port, cookie, '/api/agent/library/schedule/hub-refresh/enable', {})).status, 400);
    assert.equal((await post(srv, port, cookie, '/api/agent/library/schedule/no-such-job/enable', { enabled: true })).status, 404);
    assert.equal(calls.setEnabled.length, 1);
  } finally { await srv.close(); }
});

test('schedule DELETE → def removed + state entry pruned; second delete → 404', async () => {
  const { meshRoot, agentRoot } = await buildMesh();
  await seedSchedule(agentRoot, [dailyJob(), dailyJob({ id: 'keeper', name: 'Keeper' })]);
  const stateFile = join(agentRoot, '.agent-mesh', 'schedule-state.json');
  await mkdir(join(agentRoot, '.agent-mesh'), { recursive: true });
  await writeFile(stateFile, JSON.stringify({
    'hub-refresh': { lastStatus: 'ok', nextRunAt: '2026-06-12T07:00:00.000Z', running: false },
    keeper: { lastStatus: 'fail', running: false }
  }), 'utf8');
  const { scheduler } = stubScheduler();
  const { srv, port, cookie } = await authed(meshRoot, { scheduler });
  try {
    const r = await del(srv, port, cookie, '/api/agent/library/schedule/hub-refresh');
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });

    const defs = await readDefs(agentRoot);
    assert.deepEqual(defs.jobs.map((j) => j.id), ['keeper'], 'deleted def gone, sibling kept');
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(state['hub-refresh'], undefined, 'state entry pruned (best-effort)');
    assert.ok(state.keeper, 'sibling state kept');

    assert.equal((await del(srv, port, cookie, '/api/agent/library/schedule/hub-refresh')).status, 404);
  } finally { await srv.close(); }
});

test('schedule id-addressed routes: bad id chars → 400; unknown agent → 404', async () => {
  const { meshRoot } = await buildMesh();
  const { scheduler, calls } = stubScheduler();
  const { srv, port, cookie } = await authed(meshRoot, { scheduler });
  try {
    assert.equal((await post(srv, port, cookie, '/api/agent/library/schedule/bad%24id/run')).status, 400);
    assert.equal((await post(srv, port, cookie, '/api/agent/library/schedule/a%2e%2eb/enable', { enabled: true })).status, 400);
    assert.equal((await del(srv, port, cookie, '/api/agent/library/schedule/bad%24id')).status, 400);
    assert.equal((await post(srv, port, cookie, '/api/agent/no-such-agent/schedule/hub-refresh/run')).status, 404);
    assert.equal((await post(srv, port, cookie, '/api/agent/no-such-agent/schedule/hub-refresh/enable', { enabled: true })).status, 404);
    assert.equal((await del(srv, port, cookie, '/api/agent/no-such-agent/schedule/hub-refresh')).status, 404);
    assert.equal(calls.runNow.length + calls.setEnabled.length, 0, 'stub never reached');
  } finally { await srv.close(); }
});
