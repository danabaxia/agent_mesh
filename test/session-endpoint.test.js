/**
 * test/session-endpoint.test.js — gating + wiring of the dashboard-native
 * session endpoints (stream/message/stop) with an injected runner.
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
  const meshRoot = await mkdtemp(join(tmpdir(), 'sess-ep-'));
  await initMesh(meshRoot);
  const agentRoot = join(meshRoot, 'alpha');
  await mkdir(agentRoot, { recursive: true });
  await writeFile(join(agentRoot, 'agent.json'), JSON.stringify({ name: 'alpha' }), 'utf8');
  await writeManifest(meshRoot, { meshVersion: '0.1.0', agents: [{ name: 'alpha', root: './alpha', card: 'agent.json', served: true, enabledModes: ['ask'], peers: [] }] });
  return { meshRoot };
}
async function authed(meshRoot, opts = {}) {
  const srv = createDashboardServer({ meshRoot, port: 0, ...opts });
  await srv.start();
  const port = new URL(srv.url).port;
  const boot = await fetch(`${srv.url}/?t=${srv.token}`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'none' }, redirect: 'manual' });
  const cookie = `am_dash=${boot.headers.get('set-cookie').match(/am_dash=([^;]+)/)[1]}`;
  return { srv, port, cookie };
}
const post = (srv, port, cookie, path, body) => fetch(`${srv.url}${path}`, {
  method: 'POST', headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body || {})
});

test('session disabled by default → 403 shell_disabled; sessionLogEnabled false', async () => {
  const { meshRoot } = await buildMesh();
  const { srv, port, cookie } = await authed(meshRoot);
  try {
    const res = await post(srv, port, cookie, '/api/agent/alpha/session/message', { text: 'hi' });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'shell_disabled');
    const mesh = await (await fetch(`${srv.url}/api/mesh`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie } })).json();
    assert.equal(mesh.sessionLogEnabled, false);
  } finally { await srv.close(); }
});

test('enabled (injected runner) → message returns 202+turnId, busy → 409, sessionLogEnabled true', async () => {
  const { meshRoot } = await buildMesh();
  let started = 0;
  const runner = {
    runTurn: async () => { started++; if (started === 2) { const e = new Error('session_busy'); e.code = 'session_busy'; e.owner = 'dashboard'; throw e; } return { turnId: 'T1', done: Promise.resolve({ ok: true }) }; },
    stop: async () => {}, subscribe: () => ({ close() {} })
  };
  // Driving a session turn from the dashboard is in-dashboard chat → needs chat:true.
  const { srv, port, cookie } = await authed(meshRoot, { sessionRunner: runner, chat: true });
  try {
    const r1 = await post(srv, port, cookie, '/api/agent/alpha/session/message', { text: 'hi' });
    assert.equal(r1.status, 202);
    assert.equal((await r1.json()).turnId, 'T1');
    const r2 = await post(srv, port, cookie, '/api/agent/alpha/session/message', { text: 'again' });
    assert.equal(r2.status, 409);
    assert.equal((await r2.json()).error.code, 'session_busy');
    const mesh = await (await fetch(`${srv.url}/api/mesh`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie } })).json();
    assert.equal(mesh.sessionLogEnabled, true);
  } finally { await srv.close(); }
});

test('the old driven GET /session/stream is gone (live mirror is /session/:id/stream)', async () => {
  // The driven runner-hub SSE was removed: the canvas now renders from the single
  // line-index cursor of the live mirror (/session/:id/stream). The flat
  // /session/stream verb is no longer a route → 404.
  const { meshRoot } = await buildMesh();
  const runner = { runTurn: async () => ({ turnId: 'T', done: Promise.resolve({ ok: true }) }), stop: async () => {}, subscribe: () => ({ close() {} }) };
  const { srv, port, cookie } = await authed(meshRoot, { sessionRunner: runner });
  try {
    const res = await fetch(`${srv.url}/api/agent/alpha/session/stream`, {
      headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie }
    });
    assert.equal(res.status, 404);
  } finally { await srv.close(); }
});

test('unknown agent → 404; missing cookie → 403', async () => {
  const { meshRoot } = await buildMesh();
  const runner = { runTurn: async () => ({ turnId: 'T', done: Promise.resolve({ ok: true }) }), stop: async () => {}, subscribe: () => ({ close() {} }) };
  const { srv, port, cookie } = await authed(meshRoot, { sessionRunner: runner });
  try {
    const unknown = await post(srv, port, cookie, '/api/agent/ghost/session/message', { text: 'x' });
    assert.equal(unknown.status, 404);
    const noCookie = await fetch(`${srv.url}/api/agent/alpha/session/message`, {
      method: 'POST', headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' }, body: '{}'
    });
    assert.equal(noCookie.status, 403);
  } finally { await srv.close(); }
});
