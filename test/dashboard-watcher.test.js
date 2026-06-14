/**
 * test/dashboard-watcher.test.js
 *
 * Tests for the mesh-root change watcher (src/dashboard/watcher.js) and the SSE
 * /api/events route. Hermetic — tmp dirs + ephemeral ports.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';

import { createMeshWatcher } from '../src/dashboard/watcher.js';
import { createDashboardServer } from '../src/dashboard/server.js';
import { initMesh } from '../src/builder/init-mesh.js';
import { writeManifest } from '../src/builder/manifest.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function buildMesh() {
  const meshRoot = await mkdtemp(join(tmpdir(), 'dash-watch-'));
  await initMesh(meshRoot);
  const agentRoot = join(meshRoot, 'alpha');
  await mkdir(join(agentRoot, 'prompts'), { recursive: true });
  await writeFile(
    join(agentRoot, 'agent.json'),
    JSON.stringify({ name: 'alpha', 'x-agentmesh': { modes: ['ask'] } }),
    'utf8'
  );
  await writeFile(join(agentRoot, 'prompts', 'system.md'), '# alpha', 'utf8');
  await writeManifest(meshRoot, {
    meshVersion: '0.1.0',
    agents: [{ name: 'alpha', root: './alpha', card: 'agent.json', served: true, enabledModes: ['ask'], peers: [] }]
  });
  return { meshRoot, agentRoot };
}

// ---------------------------------------------------------------------------
// Watcher unit
// ---------------------------------------------------------------------------

test('watcher emits a coarse change with the agent scope on a file write', async () => {
  const { meshRoot, agentRoot } = await buildMesh();
  const events = [];
  const w = createMeshWatcher({
    meshRoot,
    agentDirs: ['alpha'],
    onChange: (e) => events.push(e),
    debounceMs: 20,
    pollMs: 100000 // rely on manual poll() for determinism
  });
  await w.ready;
  try {
    await writeFile(join(agentRoot, 'prompts', 'system.md'), '# alpha v2', 'utf8');
    await w.poll();
    await sleep(60);
    assert.ok(events.length >= 1, 'expected at least one change event');
    const scopes = events.flatMap((e) => e.scopes);
    assert.ok(scopes.includes('alpha'), `expected scope "alpha", got ${JSON.stringify(scopes)}`);
  } finally {
    w.close();
  }
});

test('watcher detects a secret-file change but redacts the path (scope=mesh)', async () => {
  const { meshRoot } = await buildMesh();
  const events = [];
  const w = createMeshWatcher({
    meshRoot,
    agentDirs: ['alpha'],
    onChange: (e) => events.push(e),
    debounceMs: 20,
    pollMs: 100000
  });
  await w.ready;
  try {
    await writeFile(join(meshRoot, '.env'), 'SECRET=1', 'utf8');
    await w.poll();
    await sleep(60);
    assert.ok(events.length >= 1, 'secret change must still emit a coarse event');
    const serialized = JSON.stringify(events);
    assert.ok(!serialized.includes('.env'), 'secret filename must never appear in the event');
    const scopes = events.flatMap((e) => e.scopes);
    assert.ok(scopes.every((s) => s === 'mesh'), `secret change scope must be "mesh", got ${JSON.stringify(scopes)}`);
  } finally {
    w.close();
  }
});

test('watcher emits nothing after close()', async () => {
  const { meshRoot, agentRoot } = await buildMesh();
  const events = [];
  const w = createMeshWatcher({
    meshRoot,
    agentDirs: ['alpha'],
    onChange: (e) => events.push(e),
    debounceMs: 20,
    pollMs: 100000
  });
  await w.ready;
  w.close();
  await writeFile(join(agentRoot, 'prompts', 'system.md'), '# alpha v3', 'utf8');
  await w.poll();
  await sleep(60);
  assert.equal(events.length, 0, 'no events should fire after close()');
});

// ---------------------------------------------------------------------------
// SSE route integration
// ---------------------------------------------------------------------------

async function startAuthed(meshRoot) {
  const srv = createDashboardServer({ meshRoot, port: 0, watchPollMs: 100 });
  await srv.start();
  const port = new URL(srv.url).port;
  const token = srv.token;
  const boot = await fetch(`${srv.url}/?t=${token}`, {
    headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'none' },
    redirect: 'manual'
  });
  const cookie = `am_dash=${boot.headers.get('set-cookie').match(/am_dash=([^;]+)/)[1]}`;
  return { srv, port, cookie };
}

/** Open an SSE connection and accumulate the stream into `state.buf`. */
function openSse(port, cookie, state) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: '/api/events',
        method: 'GET',
        headers: {
          Host: `127.0.0.1:${port}`,
          'Sec-Fetch-Site': 'same-origin',
          Accept: 'text/event-stream',
          Cookie: cookie
        }
      },
      (res) => {
        state.status = res.statusCode;
        state.contentType = res.headers['content-type'] || '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { state.buf += chunk; });
        resolve({ req, res });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(40);
  }
  return false;
}

test('SSE /api/events streams a change event when a file changes', async () => {
  const { meshRoot, agentRoot } = await buildMesh();
  const { srv, port, cookie } = await startAuthed(meshRoot);
  const state = { buf: '', status: 0, contentType: '' };
  const { req } = await openSse(port, cookie, state);
  try {
    assert.equal(state.status, 200);
    assert.ok(state.contentType.includes('text/event-stream'), `got ${state.contentType}`);
    // Wait for the initial comment so the watcher is armed.
    await waitFor(() => state.buf.includes(': connected'));

    await writeFile(join(agentRoot, 'prompts', 'system.md'), '# changed', 'utf8');
    const got = await waitFor(() => state.buf.includes('event: change'));
    assert.ok(got, `expected a change event, stream so far: ${state.buf}`);
  } finally {
    req.destroy();
    await srv.close();
  }
});

test('SSE change for a secret file does not leak the path', async () => {
  const { meshRoot } = await buildMesh();
  const { srv, port, cookie } = await startAuthed(meshRoot);
  const state = { buf: '', status: 0, contentType: '' };
  const { req } = await openSse(port, cookie, state);
  try {
    await waitFor(() => state.buf.includes(': connected'));
    await writeFile(join(meshRoot, '.env'), 'SECRET=2', 'utf8');
    const got = await waitFor(() => state.buf.includes('event: change'));
    assert.ok(got, 'secret change must still emit a coarse event');
    assert.ok(!state.buf.includes('.env'), `stream must not leak ".env": ${state.buf}`);
  } finally {
    req.destroy();
    await srv.close();
  }
});

test('SSE /api/events requires the auth cookie', async () => {
  const { meshRoot } = await buildMesh();
  const { srv, port } = await startAuthed(meshRoot);
  const state = { buf: '', status: 0, contentType: '' };
  // No cookie → expect 403, not a stream.
  const { req } = await new Promise((resolve, reject) => {
    const r = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: '/api/events',
        method: 'GET',
        headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' }
      },
      (res) => {
        state.status = res.statusCode;
        res.on('data', () => {});
        resolve({ req: r, res });
      }
    );
    r.on('error', reject);
    r.end();
  });
  try {
    assert.equal(state.status, 403);
  } finally {
    req.destroy();
    await srv.close();
  }
});
