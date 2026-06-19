// test/tokens-routes.test.js — GET /api/tokens?range= reads the per-date daily
// caches and returns the aggregated token-panel model. Harness mirrors daily-routes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardServer } from '../src/dashboard/server.js';
import { initMesh } from '../src/builder/init-mesh.js';
import { writeManifest } from '../src/builder/manifest.js';

async function buildMesh() {
  const meshRoot = await mkdtemp(join(tmpdir(), 'tokroutes-'));
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
const get = (srv, port, cookie, p) => fetch(`${srv.url}${p}`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie } });

const model = (date, locIn, ciIn, cost) => ({
  date,
  tokens: {
    local: { input: locIn, output: locIn * 0.1, costUsd: cost, runs: 2, byRoute: { coder: { input: locIn, output: locIn * 0.1 } } },
    ci: { input: ciIn, output: ciIn * 0.1, costUsd: 0, runs: 5, byWorkflow: { 'dev-mesh-review': { input: ciIn, output: ciIn * 0.1 } } },
    total: { input: locIn + ciIn, output: (locIn + ciIn) * 0.1, turns: 10 },
  },
});

test('GET /api/tokens?range=today reads the latest cache', async () => {
  const { meshRoot } = await buildMesh();
  const dir = await mkdtemp(join(tmpdir(), 'tokcache-'));
  await writeFile(join(dir, 'daily-report.json'), JSON.stringify(model('2026-06-18', 100, 1000, 0.5)));
  const { srv, port, cookie } = await authed(meshRoot, { dailyReportDir: dir });
  try {
    const r = await get(srv, port, cookie, '/api/tokens?range=today');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.range, 'today');
    assert.equal(body.model.days, 1);
    assert.equal(body.model.cost, 0.5);
    assert.equal(body.model.local, 110);
    assert.equal(body.model.byConsumer[0].name, 'dev-mesh-review'); // 1100 > coder 110
  } finally { await srv.close(); }
});

test('GET /api/tokens?range=week sums dated caches that exist', async () => {
  const { meshRoot } = await buildMesh();
  const dir = await mkdtemp(join(tmpdir(), 'tokcache-'));
  const today = new Date().toISOString().slice(0, 10);
  const yest = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  await writeFile(join(dir, `daily-report-${today}.json`), JSON.stringify(model(today, 50, 500, 0.25)));
  await writeFile(join(dir, `daily-report-${yest}.json`), JSON.stringify(model(yest, 50, 500, 0.25)));
  const { srv, port, cookie } = await authed(meshRoot, { dailyReportDir: dir });
  try {
    const body = await (await get(srv, port, cookie, '/api/tokens?range=week')).json();
    assert.equal(body.range, 'week');
    assert.equal(body.model.days, 2);
    assert.ok(Math.abs(body.model.cost - 0.5) < 1e-9); // 0.25 + 0.25
    assert.equal(body.model.trend.length, 2);
  } finally { await srv.close(); }
});

test('GET /api/tokens with no caches → zeroed model, still 200', async () => {
  const { meshRoot } = await buildMesh();
  const dir = await mkdtemp(join(tmpdir(), 'tokcache-empty-'));
  const { srv, port, cookie } = await authed(meshRoot, { dailyReportDir: dir });
  try {
    const body = await (await get(srv, port, cookie, '/api/tokens?range=today')).json();
    assert.equal(body.model.days, 0);
    assert.equal(body.model.total, 0);
  } finally { await srv.close(); }
});
