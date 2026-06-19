// test/schedules-route.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardServer } from '../src/dashboard/server.js';
import { initMesh } from '../src/builder/init-mesh.js';
import { writeManifest } from '../src/builder/manifest.js';

async function buildMesh() {
  const meshRoot = await mkdtemp(join(tmpdir(), 'schedroutes-'));
  await initMesh(meshRoot);
  const coder = join(meshRoot, 'coder');
  await mkdir(join(coder, '.agent'), { recursive: true });
  await mkdir(join(coder, '.agent-mesh'), { recursive: true });
  await writeFile(join(coder, 'agent.json'), JSON.stringify({ name: 'coder' }), 'utf8');
  await writeFile(join(coder, '.agent', 'schedule.json'), JSON.stringify({ jobs: [{ id: 'j1', name: 'Nightly', cadence: { kind: 'daily', at: '07:00' }, enabled: true }] }), 'utf8');
  await writeFile(join(coder, '.agent-mesh', 'schedule-state.json'), JSON.stringify({ j1: { lastStatus: 'ok', nextRunAt: '2026-06-19T07:00:00Z', running: false } }), 'utf8');
  await writeManifest(meshRoot, { meshVersion: '0.1.0', agents: [{ name: 'coder', root: './coder', card: 'agent.json', served: true, enabledModes: ['ask'], peers: [] }] });
  return { meshRoot };
}
async function authed(meshRoot, opts = {}) {
  const srv = createDashboardServer({ meshRoot, port: 0, ...opts });
  await srv.start(); const port = new URL(srv.url).port;
  const boot = await fetch(`${srv.url}/?t=${srv.token}`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'none' }, redirect: 'manual' });
  const cookie = `am_dash=${boot.headers.get('set-cookie').match(/am_dash=([^;]+)/)[1]}`;
  return { srv, port, cookie };
}
const get = (srv, port, cookie, p) => fetch(`${srv.url}${p}`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie } });

test('GET /api/schedules aggregates agent jobs; owner=daemon when dashboard has no scheduler', async () => {
  const { meshRoot } = await buildMesh();
  const { srv, port, cookie } = await authed(meshRoot);  // no allowShell → dashboard owns no scheduler
  try {
    const r = await get(srv, port, cookie, '/api/schedules');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.schedulerOwner, 'daemon');
    assert.equal(body.jobs.length, 1);
    assert.equal(body.jobs[0].agent, 'coder');
    assert.equal(body.jobs[0].lastStatus, 'ok');
  } finally { await srv.close(); }
});

test('GET /api/schedules without cookie → 403', async () => {
  const { meshRoot } = await buildMesh();
  const srv = createDashboardServer({ meshRoot, port: 0 });
  await srv.start(); const port = new URL(srv.url).port;
  try {
    const r = await fetch(`${srv.url}/api/schedules`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' } });
    assert.equal(r.status, 403);
  } finally { await srv.close(); }
});
