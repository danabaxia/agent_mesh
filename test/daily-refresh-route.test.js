// test/daily-refresh-route.test.js — POST /api/daily/refresh regenerates the Daily
// Mesh Report cache on demand (runs daily-report.mjs), then returns the fresh report.
// regenerateDaily is injectable so the route is hermetically testable (no gh/spawn).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardServer, repoSlugFromRemote } from '../src/dashboard/server.js';
import { initMesh } from '../src/builder/init-mesh.js';
import { writeManifest } from '../src/builder/manifest.js';

async function buildMesh() {
  const meshRoot = await mkdtemp(join(tmpdir(), 'dailyrefresh-'));
  await initMesh(meshRoot);
  await mkdir(join(meshRoot, 'library'), { recursive: true });
  await writeFile(join(meshRoot, 'library', 'agent.json'), JSON.stringify({ name: 'library' }), 'utf8');
  await writeManifest(meshRoot, { meshVersion: '0.1.0', agents: [{ name: 'library', root: './library', card: 'agent.json', served: true, enabledModes: ['ask'], peers: [] }] });
  return { meshRoot };
}
async function authed(meshRoot, opts = {}) {
  const srv = createDashboardServer({ meshRoot, port: 0, ...opts });
  await srv.start(); const port = new URL(srv.url).port;
  const boot = await fetch(`${srv.url}/?t=${srv.token}`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'none' }, redirect: 'manual' });
  const cookie = `am_dash=${boot.headers.get('set-cookie').match(/am_dash=([^;]+)/)[1]}`;
  return { srv, port, cookie };
}
const post = (srv, port, cookie, p) => fetch(`${srv.url}${p}`, { method: 'POST', headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie } });

test('repoSlugFromRemote parses https and ssh remotes (so the regen can set DEV_SOCIETY_REPO)', () => {
  assert.equal(repoSlugFromRemote('https://github.com/danabaxia/agent_mesh.git'), 'danabaxia/agent_mesh');
  assert.equal(repoSlugFromRemote('https://github.com/danabaxia/agent_mesh'), 'danabaxia/agent_mesh');
  assert.equal(repoSlugFromRemote('git@github.com:danabaxia/agent_mesh.git'), 'danabaxia/agent_mesh');
  assert.equal(repoSlugFromRemote('git@github.com:danabaxia/agent_mesh.git\n'), 'danabaxia/agent_mesh');
  assert.equal(repoSlugFromRemote(''), '');
  assert.equal(repoSlugFromRemote(undefined), '');
});

test('POST /api/daily/refresh runs the regenerator then returns the fresh report', async () => {
  const { meshRoot } = await buildMesh();
  const dir = await mkdtemp(join(tmpdir(), 'drcache-'));
  const cache = join(dir, 'daily-report.json');
  let calls = 0;
  const regenerateDaily = async () => { calls++; await writeFile(cache, JSON.stringify({ date: '2026-06-19', issues: { openNow: 7 }, prs: { openNow: 1 } })); };
  const { srv, port, cookie } = await authed(meshRoot, { dailyReportPath: cache, regenerateDaily });
  try {
    const r = await post(srv, port, cookie, '/api/daily/refresh');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.available, true);
    assert.equal(body.report.issues.openNow, 7);
    assert.equal(calls, 1, 'regenerator ran exactly once');
  } finally { await srv.close(); }
});

test('POST /api/daily/refresh returns 502 when regeneration fails', async () => {
  const { meshRoot } = await buildMesh();
  const regenerateDaily = async () => { throw new Error('boom'); };
  const { srv, port, cookie } = await authed(meshRoot, { regenerateDaily });
  try {
    const r = await post(srv, port, cookie, '/api/daily/refresh');
    assert.equal(r.status, 502);
    const body = await r.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'refresh_failed');
  } finally { await srv.close(); }
});

test('POST /api/daily/refresh dedupes concurrent regenerations (one in-flight run)', async () => {
  const { meshRoot } = await buildMesh();
  const dir = await mkdtemp(join(tmpdir(), 'drcache-'));
  const cache = join(dir, 'daily-report.json');
  let calls = 0;
  const regenerateDaily = async () => { calls++; await new Promise((r) => setTimeout(r, 80)); await writeFile(cache, JSON.stringify({ date: 'x', issues: { openNow: 1 } })); };
  const { srv, port, cookie } = await authed(meshRoot, { dailyReportPath: cache, regenerateDaily });
  try {
    const [a, b, c] = await Promise.all([
      post(srv, port, cookie, '/api/daily/refresh'),
      post(srv, port, cookie, '/api/daily/refresh'),
      post(srv, port, cookie, '/api/daily/refresh'),
    ]);
    assert.deepEqual([a.status, b.status, c.status], [200, 200, 200]);
    assert.equal(calls, 1, 'three concurrent requests coalesce into one regeneration');
  } finally { await srv.close(); }
});
