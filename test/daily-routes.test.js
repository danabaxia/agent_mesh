/**
 * test/daily-routes.test.js — GET /api/daily: the mesh-wide Daily Mesh Report
 * tab reads a cached report model (written by scripts/daily-report.mjs), so the
 * dashboard never shells gh on page load. Harness mirrors activity-stats-routes.
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
  const meshRoot = await mkdtemp(join(tmpdir(), 'dailyroutes-'));
  await initMesh(meshRoot);
  const agentRoot = join(meshRoot, 'library');
  await mkdir(agentRoot, { recursive: true });
  await writeFile(join(agentRoot, 'agent.json'), JSON.stringify({ name: 'library' }), 'utf8');
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
const get = (srv, port, cookie, p) => fetch(`${srv.url}${p}`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie } });

test('GET /api/daily → available:true with the cached report model', async () => {
  const { meshRoot } = await buildMesh();
  const cacheDir = await mkdtemp(join(tmpdir(), 'dailycache-'));
  const cachePath = join(cacheDir, 'daily-report.json');
  const model = {
    date: '2026-06-18',
    prs: { opened: [{ number: 1, title: 'a', url: 'u' }], merged: [], closed: [], openNow: 3 },
    issues: { opened: [], closed: [], openByLabel: { approved: 2 } },
    tokens: { local: { input: 10 }, ci: { input: 20 }, total: { input: 30 } },
    generatedAt: '2026-06-18T08:00:00.000Z',
  };
  await writeFile(cachePath, JSON.stringify(model), 'utf8');

  const { srv, port, cookie } = await authed(meshRoot, { dailyReportPath: cachePath });
  try {
    const r = await get(srv, port, cookie, '/api/daily');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.available, true);
    assert.equal(body.report.date, '2026-06-18');
    assert.equal(body.report.prs.openNow, 3);
    assert.equal(body.report.tokens.total.input, 30);
    assert.equal(body.report.generatedAt, '2026-06-18T08:00:00.000Z');
  } finally { await srv.close(); }
});

test('GET /api/daily → available:false when no report has been generated', async () => {
  const { meshRoot } = await buildMesh();
  const { srv, port, cookie } = await authed(meshRoot, { dailyReportPath: join(tmpdir(), 'does-not-exist-daily-report.json') });
  try {
    const r = await get(srv, port, cookie, '/api/daily');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.available, false);
  } finally { await srv.close(); }
});

test('GET /api/daily inherits the auth gate (401/403 without cookie)', async () => {
  const { meshRoot } = await buildMesh();
  const srv = createDashboardServer({ meshRoot, port: 0 });
  await srv.start();
  const port = new URL(srv.url).port;
  try {
    const r = await fetch(`${srv.url}/api/daily`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' } });
    assert.equal(r.status, 403);
  } finally { await srv.close(); }
});
