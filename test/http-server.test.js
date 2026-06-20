import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createA2AHttpServer } from '../src/a2a/http-server.js';

// Pick a unique port range per test to avoid conflicts when tests run concurrently.
let portCounter = 14747;
function nextPort() { return portCounter++; }

async function startHttpServer(root, env = {}, port) {
  const p = port ?? nextPort();
  const server = await createA2AHttpServer({ root, port: p, host: '127.0.0.1', env });
  await server.start();
  return { server, url: server.url };
}

async function rpcPost(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

test('HTTP server responds to initialize with AgentCard', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-http-'));
  await writeFile(join(root, 'AGENT.md'), 'Owns HTTP tests.');
  const { server, url } = await startHttpServer(root);
  try {
    const res = await rpcPost(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.equal(res.result.agentCard.name, root.split(/[/\\]/).at(-1));
    assert.equal(res.result.agentCard.supportedInterfaces[0].protocolBinding, 'JSONRPC');
    assert.match(res.result.agentCard.supportedInterfaces[0].url, /^http:\/\/127\.0\.0\.1:/);
  } finally {
    await server.close();
  }
});

test('HTTP server responds to ping', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-http-'));
  await writeFile(join(root, 'AGENT.md'), 'Owns HTTP tests.');
  const { server, url } = await startHttpServer(root);
  try {
    const res = await rpcPost(url, { jsonrpc: '2.0', id: 2, method: 'ping', params: {} });
    assert.deepEqual(res, { jsonrpc: '2.0', id: 2, result: {} });
  } finally {
    await server.close();
  }
});

test('HTTP server returns bad input as rejected Task data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-http-'));
  await writeFile(join(root, 'AGENT.md'), 'Owns HTTP tests.');
  const { server, url } = await startHttpServer(root);
  try {
    const res = await rpcPost(url, {
      jsonrpc: '2.0',
      id: 3,
      method: 'SendMessage',
      params: { message: { parts: [{ text: 'x' }], metadata: { 'agentmesh/mode': 'invalid' } } }
    });
    const task = res.result.task;
    assert.equal(task.status.state, 'TASK_STATE_REJECTED');
    assert.equal(task.metadata['agentmesh/error_code'], 'bad_input');
  } finally {
    await server.close();
  }
});

test('HTTP server runs delegate and returns a completed Task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-http-'));
  await writeFile(join(root, 'AGENT.md'), 'Owns HTTP tests.');
  const fakeClaude = join(root, 'fake-claude.mjs');
  await writeFile(fakeClaude, "#!/usr/bin/env node\nconsole.log('http task done');\n");
  await chmod(fakeClaude, 0o755);
  const { server, url } = await startHttpServer(root, { AGENT_MESH_CLAUDE: fakeClaude });
  try {
    const res = await rpcPost(url, {
      jsonrpc: '2.0',
      id: 4,
      method: 'SendMessage',
      params: {
        message: {
          messageId: 'm1',
          role: 'ROLE_USER',
          parts: [{ text: fakeClaude }],
          metadata: { 'agentmesh/mode': 'ask' }
        }
      }
    });
    const task = res.result.task;
    assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
    assert.match(task.artifacts[0].parts[0].text, /http task done/);
    assert.equal(typeof task.metadata['agentmesh/metrics'].total_ms, 'number');
  } finally {
    await server.close();
  }
});

test('HTTP server returns -32601 for unknown methods', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-http-'));
  await writeFile(join(root, 'AGENT.md'), 'Owns HTTP tests.');
  const { server, url } = await startHttpServer(root);
  try {
    const res = await rpcPost(url, { jsonrpc: '2.0', id: 5, method: 'bogus', params: {} });
    assert.equal(res.error.code, -32601);
  } finally {
    await server.close();
  }
});

test('HTTP server rejects non-POST requests with 405', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-http-'));
  await writeFile(join(root, 'AGENT.md'), 'Owns HTTP tests.');
  const { server, url } = await startHttpServer(root);
  try {
    const res = await fetch(url, { method: 'GET' });
    assert.equal(res.status, 405);
  } finally {
    await server.close();
  }
});

test('HTTP server returns 204 for JSON-RPC notification (no id)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-http-'));
  await writeFile(join(root, 'AGENT.md'), 'Owns HTTP notification tests.');
  const { server, url } = await startHttpServer(root);
  try {
    // JSON-RPC notification: same structure as a request but no `id` field.
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', params: {} })
    });
    assert.equal(res.status, 204);
  } finally {
    await server.close();
  }
});

test('HTTP server mode_disabled gate: capability gate from agent.json', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-http-'));
  await writeFile(join(root, 'AGENT.md'), 'Owns HTTP tests.');
  await writeFile(join(root, 'agent.json'), JSON.stringify({ 'x-agentmesh': { modes: ['ask'] } }));
  const { server, url } = await startHttpServer(root);
  try {
    const res = await rpcPost(url, {
      jsonrpc: '2.0',
      id: 6,
      method: 'SendMessage',
      params: {
        message: {
          messageId: 'm2',
          role: 'ROLE_USER',
          parts: [{ text: 'write something' }],
          metadata: { 'agentmesh/mode': 'do' }
        }
      }
    });
    assert.equal(res.result.task.metadata['agentmesh/error_code'], 'mode_disabled');
  } finally {
    await server.close();
  }
});
