/**
 * test/dashboard-console.test.js
 *
 * Tests for the Desk console broker (src/dashboard/console.js) and its HTTP
 * route in src/dashboard/server.js. Hermetic — the A2A client is injected as a
 * fake (no real `serve-a2a`/`claude` spawn).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createConsoleBroker,
  generateCallerRegistry,
  deriveDelegations,
  ConsoleError
} from '../src/dashboard/console.js';
import { createDashboardServer } from '../src/dashboard/server.js';
import { initMesh } from '../src/builder/init-mesh.js';
import { writeManifest } from '../src/builder/manifest.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A mesh with one served agent (alpha), one unserved (beta). */
async function buildMesh() {
  const meshRoot = await mkdtemp(join(tmpdir(), 'dash-console-'));
  await initMesh(meshRoot);
  await writeManifest(meshRoot, {
    meshVersion: '0.1.0',
    agents: [
      { name: 'alpha', root: './alpha', card: 'agent.json', served: true, enabledModes: ['ask'], peers: [] },
      { name: 'beta', root: './beta', card: 'agent.json', served: false, enabledModes: ['ask'], peers: [] }
    ]
  });
  return meshRoot;
}

function okTask(text = 'Hello **world**') {
  return {
    id: 't1',
    contextId: 'c1',
    status: { state: 'TASK_STATE_COMPLETED', message: { role: 'ROLE_AGENT', parts: [{ text: 'ok' }] }, timestamp: new Date().toISOString() },
    artifacts: [{ artifactId: 't1-summary', name: 'summary', parts: [{ text }] }],
    metadata: {
      'agentmesh/log_path': '/logs/t1.json',
      'agentmesh/files_changed': ['notes.md'],
      'agentmesh/metrics': { total_ms: 12 }
    }
  };
}

/**
 * Fake A2A client factory. Records calls; `send` returns okTask after an
 * optional delay while tracking max concurrency on a shared counter.
 */
function makeFakeClientFactory({ delayMs = 0, counter = null, task = okTask } = {}) {
  const calls = { factory: [], sent: [], closed: 0 };
  const factory = async (registry, options) => {
    calls.factory.push({ registry, options });
    return {
      async send(name, message) {
        calls.sent.push({ name, message });
        if (counter) {
          counter.active++;
          counter.max = Math.max(counter.max, counter.active);
        }
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        if (counter) counter.active--;
        return typeof task === 'function' ? task(name, message) : task;
      },
      async close() { calls.closed++; }
    };
  };
  return { factory, calls };
}

// ---------------------------------------------------------------------------
// generateCallerRegistry — pure
// ---------------------------------------------------------------------------

test('generateCallerRegistry: only served agents, keyed by own name, marker + env', () => {
  const manifest = {
    agents: [
      { name: 'alpha', root: './alpha', served: true, enabledModes: ['ask'], peers: [] },
      { name: 'beta', root: './beta', served: false, enabledModes: ['ask'], peers: [] }
    ]
  };
  const reg = generateCallerRegistry(manifest, { meshRootAbs: '/mesh', binPath: '/bin/x.js' });
  assert.equal(reg['x-agentmesh-generated'], true);
  assert.deepEqual(Object.keys(reg.peers), ['alpha']); // beta excluded
  // path.join yields '\\' on Windows; normalize for comparison (paths are correct
  // either way for spawn cwd/argv).
  const s = (x) => String(x).replace(/\\/g, '/');
  const a = reg.peers.alpha;
  assert.equal(s(a.root), '/mesh/alpha');
  assert.equal(a.command, 'node');
  assert.deepEqual(a.args.map(s), ['/bin/x.js', 'serve-a2a', '/mesh/alpha']);
  assert.equal(a.env.AGENT_MESH_ENABLED_MODES, 'ask');
  assert.equal(s(a.env.AGENT_MESH_MESH_ROOT), '/mesh/mesh');
  assert.equal(a.env.AGENT_MESH_MESH_CEILING, '/mesh');
});

// ---------------------------------------------------------------------------
// deriveDelegations — pure
// ---------------------------------------------------------------------------

test('deriveDelegations extracts log path, files changed, metrics', () => {
  const d = deriveDelegations(okTask());
  assert.equal(d.logPath, '/logs/t1.json');
  assert.deepEqual(d.filesChanged, ['notes.md']);
  assert.deepEqual(d.metrics, { total_ms: 12 });
});

test('deriveDelegations tolerates a bare task', () => {
  const d = deriveDelegations({});
  assert.equal(d.logPath, '');
  assert.equal(d.filesChanged, null);
  assert.deepEqual(d.metrics, {});
});

// ---------------------------------------------------------------------------
// Broker gates
// ---------------------------------------------------------------------------

test('broker rejects non-ask mode BEFORE any spawn (mode_disabled)', async () => {
  const meshRoot = await buildMesh();
  const { factory, calls } = makeFakeClientFactory();
  const broker = createConsoleBroker({ meshRoot, createClient: factory });
  await assert.rejects(
    () => broker.send({ agentName: 'alpha', text: 'hi', mode: 'do' }),
    (e) => e instanceof ConsoleError && e.code === 'mode_disabled'
  );
  assert.equal(calls.factory.length, 0, 'no client should be spawned');
});

test('broker rejects a non-served target (not_served)', async () => {
  const meshRoot = await buildMesh();
  const { factory, calls } = makeFakeClientFactory();
  const broker = createConsoleBroker({ meshRoot, createClient: factory });
  await assert.rejects(
    () => broker.send({ agentName: 'beta', text: 'hi' }),
    (e) => e instanceof ConsoleError && e.code === 'not_served'
  );
  assert.equal(calls.factory.length, 0);
});

test('broker rejects an unknown agent (bad_input)', async () => {
  const meshRoot = await buildMesh();
  const { factory } = makeFakeClientFactory();
  const broker = createConsoleBroker({ meshRoot, createClient: factory });
  await assert.rejects(
    () => broker.send({ agentName: 'ghost', text: 'hi' }),
    (e) => e instanceof ConsoleError && e.code === 'bad_input'
  );
});

test('broker rejects empty and oversized text (bad_input)', async () => {
  const meshRoot = await buildMesh();
  const { factory } = makeFakeClientFactory();
  const broker = createConsoleBroker({ meshRoot, createClient: factory });
  await assert.rejects(
    () => broker.send({ agentName: 'alpha', text: '   ' }),
    (e) => e instanceof ConsoleError && e.code === 'bad_input'
  );
  await assert.rejects(
    () => broker.send({ agentName: 'alpha', text: 'x'.repeat(20000) }),
    (e) => e instanceof ConsoleError && e.code === 'bad_input'
  );
});

// ---------------------------------------------------------------------------
// Broker happy path
// ---------------------------------------------------------------------------

test('broker sends ask message and returns final Task + delegations', async () => {
  const meshRoot = await buildMesh();
  const { factory, calls } = makeFakeClientFactory();
  const broker = createConsoleBroker({ meshRoot, createClient: factory });

  const result = await broker.send({ agentName: 'alpha', text: 'find the book' });
  assert.equal(result.task.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(result.delegations.logPath, '/logs/t1.json');

  assert.equal(calls.sent.length, 1);
  const { name, message } = calls.sent[0];
  assert.equal(name, 'alpha');
  assert.equal(message.metadata['agentmesh/mode'], 'ask');
  assert.equal(message.parts[0].text, 'find the book');
  assert.equal(calls.closed, 1, 'client must be closed after send');
});

// ---------------------------------------------------------------------------
// Serialization + concurrency
// ---------------------------------------------------------------------------

test('one in-flight send per agent (serialized)', async () => {
  const meshRoot = await buildMesh();
  const counter = { active: 0, max: 0 };
  const { factory } = makeFakeClientFactory({ delayMs: 25, counter });
  const broker = createConsoleBroker({ meshRoot, createClient: factory, concurrency: 4 });

  await Promise.all([
    broker.send({ agentName: 'alpha', text: 'a' }),
    broker.send({ agentName: 'alpha', text: 'b' })
  ]);
  assert.equal(counter.max, 1, 'same-agent sends must not overlap');
});

test('per-mesh concurrency cap bounds parallel sends', async () => {
  const meshRoot = await mkdtemp(join(tmpdir(), 'dash-console-cap-'));
  await initMesh(meshRoot);
  await writeManifest(meshRoot, {
    meshVersion: '0.1.0',
    agents: [
      { name: 'a1', root: './a1', card: 'agent.json', served: true, enabledModes: ['ask'], peers: [] },
      { name: 'a2', root: './a2', card: 'agent.json', served: true, enabledModes: ['ask'], peers: [] },
      { name: 'a3', root: './a3', card: 'agent.json', served: true, enabledModes: ['ask'], peers: [] }
    ]
  });
  const counter = { active: 0, max: 0 };
  const { factory } = makeFakeClientFactory({ delayMs: 25, counter });
  const broker = createConsoleBroker({ meshRoot, createClient: factory, concurrency: 1 });

  await Promise.all([
    broker.send({ agentName: 'a1', text: 'x' }),
    broker.send({ agentName: 'a2', text: 'y' }),
    broker.send({ agentName: 'a3', text: 'z' })
  ]);
  assert.equal(counter.max, 1, 'concurrency:1 must serialize across agents');
});

// ---------------------------------------------------------------------------
// Abort / disconnect cleanup
// ---------------------------------------------------------------------------

test('aborting the signal closes the client and throws aborted', async () => {
  const meshRoot = await buildMesh();
  const { factory, calls } = makeFakeClientFactory({ delayMs: 200 });
  const broker = createConsoleBroker({ meshRoot, createClient: factory });

  const controller = new AbortController();
  const p = broker.send({ agentName: 'alpha', text: 'slow', signal: controller.signal });
  setTimeout(() => controller.abort(), 20);

  await assert.rejects(p, (e) => e instanceof ConsoleError && e.code === 'aborted');
  assert.ok(calls.closed >= 1, 'client must be closed on abort');
});

// ---------------------------------------------------------------------------
// HTTP route (real broker + injected fake client)
// ---------------------------------------------------------------------------

async function startServerWithBroker(meshRoot, brokerOpts = {}) {
  const { factory, calls } = makeFakeClientFactory(brokerOpts);
  const broker = createConsoleBroker({ meshRoot, createClient: factory });
  // An injected consoleBroker implies chat is enabled (these tests exercise the
  // console route); pass chat:true explicitly for clarity.
  const srv = createDashboardServer({ meshRoot, port: 0, consoleBroker: broker, chat: true });
  await srv.start();
  const port = new URL(srv.url).port;
  const token = srv.token;
  const boot = await fetch(`${srv.url}/?t=${token}`, {
    headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'none' },
    redirect: 'manual'
  });
  const cookie = `am_dash=${boot.headers.get('set-cookie').match(/am_dash=([^;]+)/)[1]}`;
  return { srv, cookie, port, calls };
}

function postMessage(srv, port, cookie, name, body) {
  return fetch(`${srv.url}/api/agent/${encodeURIComponent(name)}/message`, {
    method: 'POST',
    headers: {
      Host: `127.0.0.1:${port}`,
      'Sec-Fetch-Site': 'same-origin',
      'Content-Type': 'application/json',
      Cookie: cookie
    },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
}

test('POST message (ask) → 200 ok:true with final Task', async () => {
  const meshRoot = await buildMesh();
  const { srv, cookie, port } = await startServerWithBroker(meshRoot);
  try {
    const res = await postMessage(srv, port, cookie, 'alpha', { text: 'hi there' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.task.status.state, 'TASK_STATE_COMPLETED');
    assert.equal(body.delegations.logPath, '/logs/t1.json');
  } finally {
    await srv.close();
  }
});

test('POST message mode:do → ok:false mode_disabled (no spawn)', async () => {
  const meshRoot = await buildMesh();
  const { srv, cookie, port, calls } = await startServerWithBroker(meshRoot);
  try {
    const res = await postMessage(srv, port, cookie, 'alpha', { text: 'hi', mode: 'do' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'mode_disabled');
    assert.equal(calls.factory.length, 0, 'must not spawn for do mode');
  } finally {
    await srv.close();
  }
});

test('POST message to non-served agent → ok:false not_served', async () => {
  const meshRoot = await buildMesh();
  const { srv, cookie, port } = await startServerWithBroker(meshRoot);
  try {
    const res = await postMessage(srv, port, cookie, 'beta', { text: 'hi' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'not_served');
  } finally {
    await srv.close();
  }
});

test('POST oversized body → 413', async () => {
  const meshRoot = await buildMesh();
  const { srv, cookie, port } = await startServerWithBroker(meshRoot);
  try {
    const huge = JSON.stringify({ text: 'x'.repeat(20000) });
    const res = await postMessage(srv, port, cookie, 'alpha', huge);
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.equal(body.ok, false);
  } finally {
    await srv.close();
  }
});

test('POST malformed JSON → 400', async () => {
  const meshRoot = await buildMesh();
  const { srv, cookie, port } = await startServerWithBroker(meshRoot);
  try {
    const res = await postMessage(srv, port, cookie, 'alpha', '{not json');
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'bad_input');
  } finally {
    await srv.close();
  }
});

test('POST message without cookie → 403', async () => {
  const meshRoot = await buildMesh();
  const { srv, port } = await startServerWithBroker(meshRoot);
  try {
    const res = await fetch(`${srv.url}/api/agent/alpha/message`, {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${port}`,
        'Sec-Fetch-Site': 'same-origin',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text: 'hi' })
    });
    assert.equal(res.status, 403);
  } finally {
    await srv.close();
  }
});

test('chat off by default: POST message → 403 chat_disabled (broker never called)', async () => {
  const meshRoot = await buildMesh();
  // No injected broker and no chat:true → in-dashboard chat is disabled.
  const srv = createDashboardServer({ meshRoot, port: 0 });
  await srv.start();
  const port = new URL(srv.url).port;
  const boot = await fetch(`${srv.url}/?t=${srv.token}`, {
    headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'none' },
    redirect: 'manual'
  });
  const cookie = `am_dash=${boot.headers.get('set-cookie').match(/am_dash=([^;]+)/)[1]}`;
  try {
    const res = await postMessage(srv, port, cookie, 'alpha', { text: 'hi' });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'chat_disabled');

    // And the flag is surfaced to the UI as chatEnabled:false.
    const mesh = await fetch(`${srv.url}/api/mesh`, {
      headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie }
    }).then((r) => r.json());
    assert.equal(mesh.chatEnabled, false);
  } finally {
    await srv.close();
  }
});
