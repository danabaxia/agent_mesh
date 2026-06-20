// test/ci-schedules-route.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardServer } from '../src/dashboard/server.js';
import { initMesh } from '../src/builder/init-mesh.js';
import { writeManifest } from '../src/builder/manifest.js';

// Bootstrap a minimal mesh under dev-mesh/ and start the dashboard.
// Returns { srv, port, cookie } with an authenticated session cookie.
async function startTestDashboard(meshRoot) {
  await initMesh(meshRoot);
  await writeManifest(meshRoot, { meshVersion: '0.1.0', agents: [] });
  const srv = createDashboardServer({ meshRoot, port: 0 });
  await srv.start();
  const port = new URL(srv.url).port;
  const boot = await fetch(`${srv.url}/?t=${srv.token}`, {
    headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'none' },
    redirect: 'manual',
  });
  const cookie = `am_dash=${boot.headers.get('set-cookie').match(/am_dash=([^;]+)/)[1]}`;
  return { srv, port, cookie };
}

const get = (srv, port, cookie, p) =>
  fetch(`${srv.url}${p}`, {
    headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie },
  });

function fixtureRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'ci-sched-'));
  mkdirSync(join(repo, 'dev-mesh'), { recursive: true });               // meshRoot = repo/dev-mesh
  mkdirSync(join(repo, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(repo, '.github', 'workflows', 'integration.yml'),
    "name: Integration (nightly)\non:\n  schedule:\n    - cron: '0 7 * * *'\n  workflow_dispatch:\n");
  return repo;
}

test('GET /api/ci-schedules returns parsed workflows; missing cache → status null', async () => {
  const repo = fixtureRepo();
  const meshRoot = join(repo, 'dev-mesh');
  const { srv, port, cookie } = await startTestDashboard(meshRoot);  // no gh-activity.json written
  try {
    const r = await get(srv, port, cookie, '/api/ci-schedules');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.workflows.length, 1);
    assert.equal(body.workflows[0].workflow, 'Integration (nightly)');
    assert.equal(body.workflows[0].status, null);          // no cache → null
  } finally { await srv.close(); rmSync(repo, { recursive: true, force: true }); }
});

test('GET /api/ci-schedules without cookie → 403', async () => {
  const repo = fixtureRepo();
  const meshRoot = join(repo, 'dev-mesh');
  const { srv, port } = await startTestDashboard(meshRoot);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/ci-schedules`, {
      headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' },
    });
    assert.equal(r.status, 403);
  } finally { await srv.close(); rmSync(repo, { recursive: true, force: true }); }
});

test('missing .github/workflows dir → { workflows: [] }', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ci-sched-'));
  mkdirSync(join(repo, 'dev-mesh'), { recursive: true });
  const meshRoot = join(repo, 'dev-mesh');
  const { srv, port, cookie } = await startTestDashboard(meshRoot);
  try {
    const r = await get(srv, port, cookie, '/api/ci-schedules');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.deepEqual(body.workflows, []);
  } finally { await srv.close(); rmSync(repo, { recursive: true, force: true }); }
});
