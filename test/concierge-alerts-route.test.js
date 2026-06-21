import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createDashboardServer } from '../src/dashboard/server.js';
import { initMesh } from '../src/builder/init-mesh.js';
import { syncAlerts } from '../src/concierge/alerts-store.js';

function raw({ port, path, headers = {} }) {
  return new Promise((res, rej) => {
    const r = httpRequest({ hostname: '127.0.0.1', port, path, method: 'GET', headers }, (x) => {
      let d = ''; x.on('data', (c) => d += c); x.on('end', () => res({ status: x.statusCode, body: d }));
    });
    r.on('error', rej); r.end();
  });
}

test('GET /api/concierge/alerts returns stored alerts (header-token auth)', async () => {
  const meshRoot = await mkdtemp(join(tmpdir(), 'ca-'));
  await initMesh(meshRoot);
  await syncAlerts(meshRoot, [{ id: 'x', severity: 'warn', kind: 'k', summary: 's', detail: '', source: 'z' }], '2026-06-21T10:00:00Z');
  const srv = createDashboardServer({ meshRoot, port: 0 });
  await srv.start();
  const port = new URL(srv.url).port, token = srv.token;
  try {
    const res = await raw({ port, path: '/api/concierge/alerts',
      headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', 'X-Dashboard-Token': token } });
    assert.equal(res.status, 200);
    const j = JSON.parse(res.body);
    assert.equal(j.ok, true);
    assert.equal(j.alerts[0].id, 'x');
  } finally { await srv.close(); }
});

test('alerts route requires auth', async () => {
  const meshRoot = await mkdtemp(join(tmpdir(), 'ca-'));
  await initMesh(meshRoot);
  const srv = createDashboardServer({ meshRoot, port: 0 });
  await srv.start();
  const port = new URL(srv.url).port;
  try {
    const res = await raw({ port, path: '/api/concierge/alerts', headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' } });
    assert.equal(res.status, 403);
  } finally { await srv.close(); }
});
