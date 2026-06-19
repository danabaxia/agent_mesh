import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDashboardServer } from '../src/dashboard/server.js';
import { initMesh } from '../src/builder/init-mesh.js';

async function boot(meshRoot) {
  const srv = createDashboardServer({ meshRoot, port: 0 });
  await srv.start();
  const port = new URL(srv.url).port;
  const r = await fetch(`${srv.url}/?t=${srv.token}`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'none' }, redirect: 'manual' });
  const cookie = `am_dash=${r.headers.get('set-cookie').match(/am_dash=([^;]+)/)[1]}`;
  return { srv, port, cookie };
}

test('GET /api/health returns the heartbeat snapshot', async () => {
  const meshRoot = await mkdtemp(join(tmpdir(), 'hb-route-'));
  await initMesh(meshRoot);
  const cacheDir = resolve(meshRoot, '..', '.dev-society');
  await mkdir(cacheDir, { recursive: true });
  await writeFile(join(cacheDir, 'heartbeat.json'), JSON.stringify({
    generatedAt: '2026-06-18T12:00:00Z',
    summary: { ok: 2, failing: 1, overdue: 0, stuck: 0, escalated: 1 },
    findings: [{ agent: 'coder', jobId: 'autofix', condition: 'failing', severity: 'error', detail: '3 consecutive failures', since: '2026-06-18T11:50:00Z', seenCount: 2 }],
    openEscalations: ['mesh-heartbeat:coder/autofix/failing'],
  }), 'utf8');

  const { srv, port, cookie } = await boot(meshRoot);
  const heartbeatFile = join(cacheDir, 'heartbeat.json');
  try {
    const r = await fetch(`${srv.url}/api/health`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.summary.failing, 1);
    assert.equal(body.findings[0].agent, 'coder');
  } finally {
    await srv.close();
    // Clean up the shared .dev-society dir so the "no snapshot" test is isolated
    await unlink(heartbeatFile).catch(() => {});
  }
});

test('GET /api/health degrades to empty health when no snapshot (never 500)', async () => {
  const meshRoot = await mkdtemp(join(tmpdir(), 'hb-route-empty-'));
  await initMesh(meshRoot);
  const { srv, port, cookie } = await boot(meshRoot);
  try {
    const r = await fetch(`${srv.url}/api/health`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.deepEqual(body.findings, []);
  } finally { await srv.close(); }
});
