/**
 * test/activity-stats-routes.test.js — GET /api/agent/:name/activity-stats
 * (?range=today|week|month, default today): run-log + artifact aggregation via
 * the pure buildActivityStats reducer.
 *
 * Harness mirrors test/artifact-routes.test.js: temp mesh + library agent,
 * token-boot → cookie auth, same-origin fetch helpers. The server is started
 * WITHOUT --allow-shell, so session-derived stats must degrade (turns/toolCalls
 * null, sessionsAvailable false).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardServer } from '../src/dashboard/server.js';
import { initMesh } from '../src/builder/init-mesh.js';
import { writeManifest } from '../src/builder/manifest.js';

async function buildMesh() {
  const meshRoot = await mkdtemp(join(tmpdir(), 'actroutes-'));
  await initMesh(meshRoot);
  const agentRoot = join(meshRoot, 'library');
  await mkdir(agentRoot, { recursive: true });
  await writeFile(join(agentRoot, 'agent.json'), JSON.stringify({ name: 'library' }), 'utf8');
  await writeManifest(meshRoot, { meshVersion: '0.1.0', agents: [{ name: 'library', root: './library', card: 'agent.json', served: true, enabledModes: ['ask'], peers: [] }] });
  return { meshRoot, agentRoot };
}

async function authed(meshRoot, opts = {}) {
  const srv = createDashboardServer({ meshRoot, port: 0, ...opts });
  await srv.start(); const port = new URL(srv.url).port;
  const boot = await fetch(`${srv.url}/?t=${srv.token}`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'none' }, redirect: 'manual' });
  const cookie = `am_dash=${boot.headers.get('set-cookie').match(/am_dash=([^;]+)/)[1]}`;
  return { srv, port, cookie };
}
const get = (srv, port, cookie, p) => fetch(`${srv.url}${p}`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie } });

const localYmd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Seed run-log files under <agentRoot>/.agent-mesh/logs/ plus one artifact.
 * Run timestamps are anchored at TODAY'S LOCAL MIDNIGHT (always >= the
 * range=today lower bound and <= now, whatever wall-clock time the test runs):
 *   delegate-<today>.jsonl  → r1 finished (60s), r2 start-only (running).
 *     The repo's run logs normally append a start record then a final record
 *     with the same id (dedupeRunRecords collapses them) — one line per run is
 *     equally valid readRunLogRecords input.
 *   a2a-<today>.jsonl       → outbound failed a2a from 'library' (30s).
 *   delegate-<back10>.jsonl → finished run 10 days back: excluded for
 *     today/week, included for month (now-31d).
 *   .agent/artifacts/<id>/context.json with savedAt = now (locked contract).
 */
async function seedFixtures(agentRoot) {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const today = localYmd(now);
  const back10Date = new Date(midnight.getTime() - 10 * 24 * 60 * 60 * 1000);
  const back10 = localYmd(back10Date);

  const logDir = join(agentRoot, '.agent-mesh', 'logs');
  await mkdir(logDir, { recursive: true });
  const iso = (ms) => new Date(ms).toISOString();
  const t0 = midnight.getTime();

  await writeFile(join(logDir, `delegate-${today}.jsonl`),
    JSON.stringify({ id: 'r1', route: 'ask', started_at: iso(t0), finished_at: iso(t0 + 60000) }) + '\n' +
    JSON.stringify({ id: 'r2', route: 'ask', started_at: iso(t0 + 1000) }) + '\n', 'utf8');

  await writeFile(join(logDir, `a2a-${today}.jsonl`),
    JSON.stringify({ kind: 'a2a', from: 'library', to: 'peer', mode: 'ask', status: 'failed', started_at: iso(t0 + 500), finished_at: iso(t0 + 30500) }) + '\n', 'utf8');

  const b0 = back10Date.getTime() + 60 * 60 * 1000;
  await writeFile(join(logDir, `delegate-${back10}.jsonl`),
    JSON.stringify({ id: 'r3', route: 'ask', started_at: iso(b0), finished_at: iso(b0 + 60000) }) + '\n', 'utf8');

  const artDir = join(agentRoot, '.agent', 'artifacts', `${today}-0900-fixture`);
  await mkdir(artDir, { recursive: true });
  await writeFile(join(artDir, 'context.json'), JSON.stringify({
    title: 'Fixture artifact', type: 'report', task: 'fixture', inputs: [], frame: [],
    source: { kind: 'text', content: 'x' }, agent: 'library',
    savedAt: new Date().toISOString(), sessionId: null, promotedTo: null
  }), 'utf8');
}

test('activity-stats: range=today → 200 with run/a2a/artifact kpis, degraded session stats', async () => {
  const { meshRoot, agentRoot } = await buildMesh();
  await seedFixtures(agentRoot);
  const { srv, port, cookie } = await authed(meshRoot);
  try {
    const r = await get(srv, port, cookie, '/api/agent/library/activity-stats?range=today');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.range, 'today');
    // r1 + r2 (delegate runs of this agent); the a2a record is OUTBOUND from
    // library (from===library), so it is NOT served.
    assert.equal(body.kpis.served, 2);
    assert.deepEqual(body.kpis.a2aOut, { total: 1, ok: 0, fail: 1 });
    assert.equal(body.kpis.artifactsSaved, 1);
    // completed in-range runs: r1 (60s) + a2a out (30s); r2 is running.
    assert.equal(body.kpis.avgRunMs, 45000);
    // no --allow-shell in this harness → session-derived stats degrade.
    assert.equal(body.sessionsAvailable, false);
    assert.equal(body.kpis.turns, null);
    assert.equal(body.kpis.toolCalls, null);
    assert.deepEqual(body.toolUsage, []);
    const channels = new Set(body.worklog.map((w) => w.channel));
    assert.ok(channels.has('delegate'), 'worklog has delegate rows');
    assert.ok(channels.has('a2a-out'), 'worklog has a2a-out row');
    assert.ok(channels.has('artifact-save'), 'worklog has artifact-save row');
  } finally { await srv.close(); }
});

test('activity-stats: range=month includes the 10-days-back run-log file → served 3', async () => {
  const { meshRoot, agentRoot } = await buildMesh();
  await seedFixtures(agentRoot);
  const { srv, port, cookie } = await authed(meshRoot);
  try {
    const r = await get(srv, port, cookie, '/api/agent/library/activity-stats?range=month');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.range, 'month');
    assert.equal(body.kpis.served, 3, 'r1 + r2 + back10 run');
    assert.deepEqual(body.kpis.a2aOut, { total: 1, ok: 0, fail: 1 });
    assert.equal(body.kpis.artifactsSaved, 1);
  } finally { await srv.close(); }
});

test('activity-stats: no range param defaults to today', async () => {
  const { meshRoot, agentRoot } = await buildMesh();
  await seedFixtures(agentRoot);
  const { srv, port, cookie } = await authed(meshRoot);
  try {
    const r = await get(srv, port, cookie, '/api/agent/library/activity-stats');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.range, 'today');
    assert.equal(body.kpis.served, 2, 'back10 run excluded by default range');
  } finally { await srv.close(); }
});

test('activity-stats: unknown range → 400', async () => {
  const { meshRoot } = await buildMesh();
  const { srv, port, cookie } = await authed(meshRoot);
  try {
    const r = await get(srv, port, cookie, '/api/agent/library/activity-stats?range=bogus');
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.ok, false);
  } finally { await srv.close(); }
});

test('activity-stats: unknown agent → 404; agent without any logs/artifacts → empty stats', async () => {
  const { meshRoot } = await buildMesh();
  const { srv, port, cookie } = await authed(meshRoot);
  try {
    assert.equal((await get(srv, port, cookie, '/api/agent/no-such-agent/activity-stats')).status, 404);
    const r = await get(srv, port, cookie, '/api/agent/library/activity-stats?range=today');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.kpis.served, 0);
    assert.deepEqual(body.kpis.a2aOut, { total: 0, ok: 0, fail: 0 });
    assert.equal(body.kpis.artifactsSaved, 0);
    assert.deepEqual(body.worklog, []);
  } finally { await srv.close(); }
});
