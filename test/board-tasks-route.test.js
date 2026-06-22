import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createDashboardServer } from '../src/dashboard/server.js';
import { initMesh } from '../src/builder/init-mesh.js';
import { createTask } from '../src/board/store.js';

function raw({ port, path, headers = {} }) {
  return new Promise((res, rej) => {
    const r = httpRequest({ hostname: '127.0.0.1', port, path, method: 'GET', headers }, (x) => {
      let d = ''; x.on('data', (c) => d += c); x.on('end', () => res({ status: x.statusCode, body: d }));
    });
    r.on('error', rej); r.end();
  });
}

test('GET /api/board/tasks returns the board tickets (header-token auth)', async () => {
  const meshRoot = await mkdtemp(join(tmpdir(), 'bt-'));
  await initMesh(meshRoot);
  await createTask(meshRoot, { from: 'analyst', to: 'tester', title: 'Run suite', objective: 'green', requirements: 'all pass' });
  const srv = createDashboardServer({ meshRoot, port: 0 });
  await srv.start();
  const port = new URL(srv.url).port, token = srv.token;
  try {
    const res = await raw({ port, path: '/api/board/tasks', headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', 'X-Dashboard-Token': token } });
    assert.equal(res.status, 200);
    const j = JSON.parse(res.body);
    assert.equal(j.ok, true);
    assert.equal(j.tasks.length, 1);
    assert.equal(j.tasks[0].title, 'Run suite');
    assert.equal(j.tasks[0].state, 'assigned');
  } finally { await srv.close(); }
});

test('empty board → { ok:true, tasks:[] }; missing token → 403', async () => {
  const meshRoot = await mkdtemp(join(tmpdir(), 'bt-'));
  await initMesh(meshRoot);
  const srv = createDashboardServer({ meshRoot, port: 0 });
  await srv.start();
  const port = new URL(srv.url).port, token = srv.token;
  try {
    const ok = await raw({ port, path: '/api/board/tasks', headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', 'X-Dashboard-Token': token } });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body), { ok: true, tasks: [] });
    const no = await raw({ port, path: '/api/board/tasks', headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' } });
    assert.equal(no.status, 403);
  } finally { await srv.close(); }
});
