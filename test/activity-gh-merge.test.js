import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDashboardServer } from '../src/dashboard/server.js';
import { initMesh } from '../src/builder/init-mesh.js';
import { writeManifest } from '../src/builder/manifest.js';

test('GET /api/activity includes GitHub-Actions records from the gh-activity cache', async () => {
  const meshRoot = await mkdtemp(join(tmpdir(), 'ghmerge-'));
  await initMesh(meshRoot);
  await mkdir(join(meshRoot, 'reviewer'), { recursive: true });
  await writeFile(join(meshRoot, 'reviewer', 'agent.json'), JSON.stringify({ name: 'reviewer' }), 'utf8');
  await writeManifest(meshRoot, { meshVersion: '0.1.0', agents: [{ name: 'reviewer', root: './reviewer', card: 'agent.json', served: true, enabledModes: ['ask'], peers: [] }] });
  const cacheDir = resolve(meshRoot, '..', '.dev-society');
  await mkdir(cacheDir, { recursive: true });
  await writeFile(join(cacheDir, 'gh-activity.json'), JSON.stringify([
    { id: 'gh-9', agent: 'reviewer', route: 'ci:dev-mesh-review', started_at: '2026-06-18T10:00:00Z' },
    { id: 'gh-9:e', kind: 'a2a', from: 'orchestrator', to: 'reviewer', mode: 'ci', status: null, started_at: '2026-06-18T10:00:00Z', at: '2026-06-18T10:00:00Z' },
  ]), 'utf8');

  const srv = createDashboardServer({ meshRoot, port: 0 });
  await srv.start(); const port = new URL(srv.url).port;
  const boot = await fetch(`${srv.url}/?t=${srv.token}`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'none' }, redirect: 'manual' });
  const cookie = `am_dash=${boot.headers.get('set-cookie').match(/am_dash=([^;]+)/)[1]}`;
  try {
    const r = await fetch(`${srv.url}/api/activity`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie } });
    const body = await r.json();
    assert.ok(body.edges.some((e) => e.from === 'orchestrator' && e.to === 'reviewer' && e.active === true), 'orchestrator→reviewer active edge present');
    assert.ok(body.agents.some((a) => a.name === 'reviewer' && a.state === 'working'), 'reviewer node working from the gh node record');
  } finally { await srv.close(); }
});
