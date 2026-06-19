import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpClientSession } from '../src/a2a/http-client.js';
import { createA2AHttpServer } from '../src/a2a/http-server.js';

let portCounter = 34747;
function nextPort() { return portCounter++; }

async function startHttpServer(root, env = {}) {
  const port = nextPort();
  const server = await createA2AHttpServer({ root, port, host: '127.0.0.1', env });
  await server.start();
  return { server, url: server.url };
}

test('HttpClientSession.request initializes against a real HTTP server', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-httpclient-'));
  await writeFile(join(root, 'AGENT.md'), 'Owns HTTP client tests.');
  const { server, url } = await startHttpServer(root);
  const peer = { name: 'test', url, type: 'http', env: {} };
  const session = new HttpClientSession(peer, {});
  try {
    const res = await session.request('initialize', {});
    assert.equal(typeof res.result.agentCard.name, 'string');
  } finally {
    await server.close();
    await session.close();
  }
});

test('HttpClientSession.request ping round-trip', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-httpclient-'));
  await writeFile(join(root, 'AGENT.md'), 'Owns HTTP client tests.');
  const { server, url } = await startHttpServer(root);
  const peer = { name: 'ping-peer', url, type: 'http', env: {} };
  const session = new HttpClientSession(peer, {});
  try {
    const res = await session.request('ping', {});
    assert.deepEqual(res.result, {});
  } finally {
    await server.close();
    await session.close();
  }
});

test('HttpClientSession sends X-AgentMesh-Path and X-AgentMesh-Depth when set in env', async () => {
  // The server will use the threaded depth=0 from the header and refuse the task.
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-httpclient-hdr-'));
  await writeFile(join(root, 'AGENT.md'), 'Owns HTTP client tests.');
  const { server, url } = await startHttpServer(root);
  const peer = { name: 'hdr-peer', url, type: 'http', env: {} };
  const session = new HttpClientSession(peer, { AGENT_MESH_DEPTH: '0' });
  try {
    const res = await session.request('SendMessage', {
      message: {
        messageId: 'm-hdr',
        role: 'ROLE_USER',
        parts: [{ text: 'test' }],
        metadata: { 'agentmesh/mode': 'ask' }
      }
    });
    assert.equal(res.result.task.metadata['agentmesh/error_code'], 'depth_budget');
  } finally {
    await server.close();
    await session.close();
  }
});

test('HttpClientSession.close() is a no-op (stateless)', async () => {
  const peer = { name: 'noop', url: 'http://127.0.0.1:1', type: 'http', env: {} };
  const session = new HttpClientSession(peer, {});
  await assert.doesNotReject(() => session.close());
});

test('HttpClientSession throws a descriptive error when peer is unreachable', async () => {
  const peer = { name: 'dead', url: 'http://127.0.0.1:1', type: 'http', env: {} };
  const session = new HttpClientSession(peer, {}, 5000);
  await assert.rejects(
    () => session.request('ping', {}),
    /A2A HTTP request.*"ping".*"dead"/
  );
});
