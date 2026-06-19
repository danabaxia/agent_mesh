import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardServer } from '../src/dashboard/server.js';
import { initMesh } from '../src/builder/init-mesh.js';
import { writeManifest } from '../src/builder/manifest.js';

async function meshWithJob() {
  const meshRoot = await mkdtemp(join(tmpdir(), 'runroute-'));
  await initMesh(meshRoot);
  const a = join(meshRoot, 'orchestrator');
  await mkdir(join(a, '.agent'), { recursive: true });
  await writeFile(join(a, 'agent.json'), JSON.stringify({ name: 'orchestrator' }), 'utf8');
  await writeFile(join(a, '.agent', 'schedule.json'), JSON.stringify({ jobs: [
    { id: 'p', name: 'poll', kind: 'builtin', builtin: 'probe', cadence: { kind: 'every', minutes: 5 }, enabled: true },
    { id: 'off', name: 'disabled job', kind: 'builtin', builtin: 'x', cadence: { kind: 'every', minutes: 5 }, enabled: false },
  ] }), 'utf8');
  await mkdir(join(a, '.agent-mesh'), { recursive: true });
  await writeFile(join(a, '.agent-mesh', 'schedule-state.json'), JSON.stringify({ p: { nextRunAt: '2030-01-01T00:00:00Z', lastStatus: 'ok' } }), 'utf8');
  await writeManifest(meshRoot, { meshVersion: '0.1.0', agents: [{ name: 'orchestrator', root: './orchestrator', card: 'agent.json', served: true, enabledModes: ['ask'], peers: [] }] });
  return { meshRoot, statePath: join(a, '.agent-mesh', 'schedule-state.json') };
}

async function boot(meshRoot) {
  const srv = createDashboardServer({ meshRoot, port: 0 });
  await srv.start();
  const port = new URL(srv.url).port;
  const r = await fetch(`${srv.url}/?t=${srv.token}`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'none' }, redirect: 'manual' });
  const cookie = `am_dash=${r.headers.get('set-cookie').match(/am_dash=([^;]+)/)[1]}`;
  return { srv, port, cookie };
}

test('POST /api/schedules/run re-arms an enabled job to now → 202', async () => {
  const { meshRoot, statePath } = await meshWithJob();
  const { srv, port, cookie } = await boot(meshRoot);
  try {
    const r = await fetch(`${srv.url}/api/schedules/run`, { method: 'POST', headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: 'orchestrator', id: 'p' }) });
    assert.equal(r.status, 202);
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.ok(Date.parse(state.p.nextRunAt) <= Date.now() + 1000);     // re-armed to ~now
    assert.equal(state.p.running, false);
    assert.equal(state.p.lastStatus, 'ok');                            // preserved
  } finally { await srv.close(); }
});

test('disabled job → 409; unknown agent/job → 404', async () => {
  const { meshRoot } = await meshWithJob();
  const { srv, port, cookie } = await boot(meshRoot);
  const post = (b) => fetch(`${srv.url}/api/schedules/run`, { method: 'POST', headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  try {
    assert.equal((await post({ agent: 'orchestrator', id: 'off' })).status, 409);
    assert.equal((await post({ agent: 'nope', id: 'p' })).status, 404);
    assert.equal((await post({ agent: 'orchestrator', id: 'ghost' })).status, 404);
  } finally { await srv.close(); }
});

test('unauthenticated → 403', async () => {
  const { meshRoot } = await meshWithJob();
  const srv = createDashboardServer({ meshRoot, port: 0 });
  await srv.start();
  const port = new URL(srv.url).port;
  try {
    const r = await fetch(`${srv.url}/api/schedules/run`, { method: 'POST', headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: 'orchestrator', id: 'p' }) });
    assert.equal(r.status, 403);
  } finally { await srv.close(); }
});
