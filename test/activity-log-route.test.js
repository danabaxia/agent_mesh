import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
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

test('GET /api/activity-log returns events + distinct agents/types, filters by query', async () => {
  const base = await mkdtemp(join(tmpdir(), 'al-route-'));
  const meshRoot = join(base, 'mesh');
  await mkdir(meshRoot, { recursive: true });
  await initMesh(meshRoot);
  const dir = resolve(meshRoot, '..', '.dev-society');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'activity-2026-06-19.jsonl'),
    JSON.stringify({ ts: '2026-06-19T10:00:00Z', source: 'daemon', agent: 'coder', type: 'delegate.done', summary: 'a' }) + '\n' +
    JSON.stringify({ ts: '2026-06-19T11:00:00Z', source: 'scheduler', agent: 'orchestrator', type: 'job.run', summary: 'b' }) + '\n', 'utf8');

  const { srv, port, cookie } = await boot(meshRoot);
  const get = (qs) => fetch(`${srv.url}/api/activity-log${qs}`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie } }).then((r) => r.json());
  try {
    const all = await get('');
    assert.equal(all.events.length, 2);
    assert.equal(all.events[0].summary, 'b');                 // newest first
    assert.deepEqual(all.agents.sort(), ['coder', 'orchestrator']);
    assert.ok(all.types.includes('job.run'));
    const filtered = await get('?agent=coder');
    assert.equal(filtered.events.length, 1);
    assert.equal(filtered.events[0].agent, 'coder');
  } finally { await srv.close(); }
});

test('GET /api/activity-log degrades to empty when no dir (never 500)', async () => {
  const base = await mkdtemp(join(tmpdir(), 'al-empty-'));
  const meshRoot = join(base, 'mesh');
  await mkdir(meshRoot, { recursive: true });
  await initMesh(meshRoot);
  const { srv, port, cookie } = await boot(meshRoot);
  try {
    const r = await fetch(`${srv.url}/api/activity-log`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie } });
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).events, []);
  } finally { await srv.close(); }
});
