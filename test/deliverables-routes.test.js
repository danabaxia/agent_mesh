/**
 * test/deliverables-routes.test.js — GET /api/agent/:name/deliverables
 * (flat recursive tree listing of an agent's deliverables/ folder).
 *
 * Harness mirrors test/session-routes.test.js: temp mesh + library agent,
 * token-boot → cookie auth, same-origin GET helper.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDashboardServer } from '../src/dashboard/server.js';
import { initMesh } from '../src/builder/init-mesh.js';
import { writeManifest } from '../src/builder/manifest.js';

async function buildMesh() {
  const meshRoot = await mkdtemp(join(tmpdir(), 'droutes-'));
  await initMesh(meshRoot);
  const agentRoot = join(meshRoot, 'library');
  await mkdir(agentRoot, { recursive: true });
  await writeFile(join(agentRoot, 'agent.json'), JSON.stringify({ name: 'library' }), 'utf8');
  await writeManifest(meshRoot, { meshVersion: '0.1.0', agents: [{ name: 'library', root: './library', card: 'agent.json', served: true, enabledModes: ['ask'], peers: [] }] });
  return { meshRoot, agentRoot };
}

// Fixture deliverables tree: deliverables/2026-06-11/sample-task/{report.md, data.csv, secret.txt, page.html}
async function seedDeliverables(agentRoot) {
  const task = join(agentRoot, 'deliverables', '2026-06-11', 'sample-task');
  await mkdir(task, { recursive: true });
  await writeFile(join(task, 'report.md'), '# hello', 'utf8');
  await writeFile(join(task, 'data.csv'), 'a,b\n1,2\n', 'utf8');
  await writeFile(join(task, 'secret.txt'), 'do not list me', 'utf8'); // isSensitivePath matches *secret*
  await writeFile(join(task, 'page.html'), '<h1>hi</h1>', 'utf8');
}

async function authed(meshRoot, opts = {}) {
  const srv = createDashboardServer({ meshRoot, port: 0, ...opts });
  await srv.start(); const port = new URL(srv.url).port;
  const boot = await fetch(`${srv.url}/?t=${srv.token}`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'none' }, redirect: 'manual' });
  const cookie = `am_dash=${boot.headers.get('set-cookie').match(/am_dash=([^;]+)/)[1]}`;
  return { srv, port, cookie };
}
const get = (srv, port, cookie, p) => fetch(`${srv.url}${p}`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie } });

// Raw-response helper for the singular /deliverable route: plain lower-cased
// header object + body text (the route returns raw bytes, not JSON).
async function getRaw(srv, port, cookie, p) {
  const r = await get(srv, port, cookie, p);
  const headers = {};
  r.headers.forEach((v, k) => { headers[k] = v; });
  return { status: r.status, headers, bodyText: await r.text() };
}

test('deliverables list: returns tree entries with size, sensitive filtered', async () => {
  const { meshRoot, agentRoot } = await buildMesh();
  await seedDeliverables(agentRoot);
  const { srv, port, cookie } = await authed(meshRoot);
  try {
    const r = await get(srv, port, cookie, '/api/agent/library/deliverables');
    assert.equal(r.status, 200);
    const body = await r.json();
    const paths = body.entries.map((e) => e.path);
    assert.ok(paths.includes('2026-06-11/sample-task/report.md'));
    assert.ok(paths.includes('2026-06-11/sample-task/data.csv'));
    assert.ok(!paths.some((p) => p.includes('secret')), 'sensitive filtered');
    const md = body.entries.find((e) => e.path.endsWith('report.md'));
    assert.equal(typeof md.size, 'number');
    assert.equal(md.size, 7);                                  // '# hello'
    assert.equal(typeof md.mtime, 'string');
    assert.ok(!Number.isNaN(Date.parse(md.mtime)), 'mtime is ISO parseable');
  } finally { await srv.close(); }
});

test('deliverables list: unknown agent → 404; missing deliverables dir → 200 empty', async () => {
  const { meshRoot } = await buildMesh();                      // no deliverables/ seeded
  const { srv, port, cookie } = await authed(meshRoot);
  try {
    assert.equal((await get(srv, port, cookie, '/api/agent/no-such-agent/deliverables')).status, 404);
    const r = await get(srv, port, cookie, '/api/agent/library/deliverables');
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).entries, []);
  } finally { await srv.close(); }
});

test('deliverable read: inline preview with correct mime', async () => {
  const { meshRoot, agentRoot } = await buildMesh();
  await seedDeliverables(agentRoot);
  const { srv, port, cookie } = await authed(meshRoot);
  try {
    const r = await getRaw(srv, port, cookie, '/api/agent/library/deliverable?path=2026-06-11%2Fsample-task%2Fdata.csv');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /text\/csv|text\/plain/);
    assert.match(r.bodyText, /a,b/);
  } finally { await srv.close(); }
});

test('deliverable read: html preview carries CSP sandbox header', async () => {
  const { meshRoot, agentRoot } = await buildMesh();
  await seedDeliverables(agentRoot);
  const { srv, port, cookie } = await authed(meshRoot);
  try {
    const r = await getRaw(srv, port, cookie, '/api/agent/library/deliverable?path=2026-06-11%2Fsample-task%2Fpage.html');
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-security-policy'], 'sandbox');
    assert.match(r.headers['content-type'], /text\/html/);
    assert.match(r.bodyText, /<h1>hi<\/h1>/);
  } finally { await srv.close(); }
});

test('deliverable read: download=1 sets attachment disposition', async () => {
  const { meshRoot, agentRoot } = await buildMesh();
  await seedDeliverables(agentRoot);
  const { srv, port, cookie } = await authed(meshRoot);
  try {
    const r = await getRaw(srv, port, cookie, '/api/agent/library/deliverable?path=2026-06-11%2Fsample-task%2Fdata.csv&download=1');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-disposition'], /attachment.*data\.csv/);
  } finally { await srv.close(); }
});

test('deliverable read: traversal and sensitive blocked', async () => {
  const { meshRoot, agentRoot } = await buildMesh();
  await seedDeliverables(agentRoot);
  const { srv, port, cookie } = await authed(meshRoot);
  try {
    assert.equal((await getRaw(srv, port, cookie, '/api/agent/library/deliverable?path=..%2Fagent.json')).status, 403);
    assert.equal((await getRaw(srv, port, cookie, '/api/agent/library/deliverable?path=2026-06-11%2Fsample-task%2Fsecret.txt')).status, 403);
  } finally { await srv.close(); }
});

test('deliverable read: missing file → 404', async () => {
  const { meshRoot, agentRoot } = await buildMesh();
  await seedDeliverables(agentRoot);
  const { srv, port, cookie } = await authed(meshRoot);
  try {
    assert.equal((await getRaw(srv, port, cookie, '/api/agent/library/deliverable?path=2026-06-11%2Fsample-task%2Fnope.md')).status, 404);
  } finally { await srv.close(); }
});

// JSON POST helper for the locate route (same-origin headers as `get`).
const post = (srv, port, cookie, p, body) => fetch(`${srv.url}${p}`, {
  method: 'POST',
  headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify(body)
});

test('locate: 403 when shell launcher disabled', async () => {
  // Default server boots WITHOUT allowShell/shellLauncher → gate closed.
  const { meshRoot, agentRoot } = await buildMesh();
  await seedDeliverables(agentRoot);
  const { srv, port, cookie } = await authed(meshRoot);
  try {
    const r = await post(srv, port, cookie, '/api/agent/library/deliverable/locate', { path: '2026-06-11/sample-task/data.csv' });
    assert.equal(r.status, 403);
    assert.match(await r.text(), /shell_disabled/);
  } finally { await srv.close(); }
});

test('locate: 404 for missing file even when shell enabled', async () => {
  // Shell gate is `!!shellLauncher` (same gate as /api/mesh shellEnabled);
  // inject a truthy stub launcher the way session-routes tests do, plus a
  // recording spawnLocate stub so nothing real ever launches.
  const { meshRoot, agentRoot } = await buildMesh();
  await seedDeliverables(agentRoot);
  const calls = [];
  const { srv, port, cookie } = await authed(meshRoot, { shellLauncher: {}, spawnLocate: (p) => calls.push(p) });
  try {
    const r = await post(srv, port, cookie, '/api/agent/library/deliverable/locate', { path: '2026-06-11/sample-task/nope.md' });
    assert.equal(r.status, 404);
    assert.equal(calls.length, 0, 'no spawn for missing file');
  } finally { await srv.close(); }
});

test('locate: success spawns with resolved full path → 200 {ok:true}', async () => {
  const { meshRoot, agentRoot } = await buildMesh();
  await seedDeliverables(agentRoot);
  const calls = [];
  const { srv, port, cookie } = await authed(meshRoot, { shellLauncher: {}, spawnLocate: (p) => calls.push(p) });
  try {
    const r = await post(srv, port, cookie, '/api/agent/library/deliverable/locate', { path: '2026-06-11/sample-task/data.csv' });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0], resolve(join(agentRoot, 'deliverables', '2026-06-11', 'sample-task', 'data.csv')));
  } finally { await srv.close(); }
});

test('locate: traversal and sensitive paths → 403 even when shell enabled', async () => {
  const { meshRoot, agentRoot } = await buildMesh();
  await seedDeliverables(agentRoot);
  const calls = [];
  const { srv, port, cookie } = await authed(meshRoot, { shellLauncher: {}, spawnLocate: (p) => calls.push(p) });
  try {
    assert.equal((await post(srv, port, cookie, '/api/agent/library/deliverable/locate', { path: '../agent.json' })).status, 403);
    assert.equal((await post(srv, port, cookie, '/api/agent/library/deliverable/locate', { path: '2026-06-11/sample-task/secret.txt' })).status, 403);
    assert.equal(calls.length, 0, 'no spawn for blocked paths');
  } finally { await srv.close(); }
});
