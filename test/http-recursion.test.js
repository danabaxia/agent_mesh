import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createA2AHttpServer } from '../src/a2a/http-server.js';
import { createA2AClient } from '../src/a2a/stdio-client.js';

let portCounter = 24747;
function nextPort() { return portCounter++; }

async function startHttpServer(root, env = {}) {
  const port = nextPort();
  const server = await createA2AHttpServer({ root, port, host: '127.0.0.1', env });
  await server.start();
  return { server, url: server.url, port };
}

async function rpcPost(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  return res.json();
}

test('HTTP server reads X-AgentMesh-Path and X-AgentMesh-Depth from request headers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-http-rec-'));
  await writeFile(join(root, 'AGENT.md'), 'Owns recursion tests.');
  const fakeClaude = join(root, 'fake-claude.mjs');
  await writeFile(fakeClaude, "#!/usr/bin/env node\nconsole.log('ok');\n");
  await chmod(fakeClaude, 0o755);
  const { server, url } = await startHttpServer(root, { AGENT_MESH_CLAUDE: fakeClaude });
  try {
    // Depth=0 means budget exhausted — the server should refuse the task.
    const res = await rpcPost(
      url,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'SendMessage',
        params: {
          message: {
            messageId: 'm-depth',
            role: 'ROLE_USER',
            parts: [{ text: 'do something' }],
            metadata: { 'agentmesh/mode': 'ask' }
          }
        }
      },
      { 'X-AgentMesh-Depth': '0' }
    );
    const task = res.result.task;
    assert.equal(task.status.state, 'TASK_STATE_REJECTED');
    assert.equal(task.metadata['agentmesh/error_code'], 'depth_budget');
  } finally {
    await server.close();
  }
});

test('HTTP server detects cycle via X-AgentMesh-Path header', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-http-cyc-'));
  await writeFile(join(root, 'AGENT.md'), 'Owns cycle tests.');
  const { server, url } = await startHttpServer(root);
  try {
    // Pass the server's own root in the path — should trigger cycle detection.
    const res = await rpcPost(
      url,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'SendMessage',
        params: {
          message: {
            messageId: 'm-cycle',
            role: 'ROLE_USER',
            parts: [{ text: 'do something' }],
            metadata: { 'agentmesh/mode': 'ask' }
          }
        }
      },
      { 'X-AgentMesh-Path': root, 'X-AgentMesh-Depth': '2' }
    );
    const task = res.result.task;
    assert.equal(task.status.state, 'TASK_STATE_REJECTED');
    assert.equal(task.metadata['agentmesh/error_code'], 'cycle');
  } finally {
    await server.close();
  }
});

test('createA2AClient dispatches to HTTP peer via url field', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-http-dispatch-'));
  await writeFile(join(root, 'AGENT.md'), 'Owns dispatch tests.');
  const { server, url } = await startHttpServer(root);
  try {
    const client = await createA2AClient({
      remote: { url }
    });
    const initialized = await client.initialize('remote');
    assert.equal(typeof initialized.agentCard.name, 'string');
    await client.close();
  } finally {
    await server.close();
  }
});

test('HTTP server caps inflated X-AgentMesh-Depth to server DEFAULT_DEPTH', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-http-cap-'));
  await writeFile(join(root, 'AGENT.md'), 'Owns depth cap tests.');
  const fakeClaude = join(root, 'fake-claude.mjs');
  // Emit AGENT_MESH_DEPTH so we can assert the child saw a capped value.
  await writeFile(fakeClaude, "#!/usr/bin/env node\nconsole.log('depth:' + (process.env.AGENT_MESH_DEPTH ?? 'unset'));\n");
  await chmod(fakeClaude, 0o755);
  // No AGENT_MESH_DEPTH in server env → DEFAULT_DEPTH (3) is the server's cap.
  const { server, url } = await startHttpServer(root, { AGENT_MESH_CLAUDE: fakeClaude });
  try {
    const res = await rpcPost(
      url,
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'SendMessage',
        params: {
          message: {
            messageId: 'm-cap',
            role: 'ROLE_USER',
            parts: [{ text: 'what is your depth?' }],
            metadata: { 'agentmesh/mode': 'ask' }
          }
        }
      },
      { 'X-AgentMesh-Depth': '99' }
    );
    const task = res.result.task;
    // Depth 99 was capped to DEFAULT_DEPTH (3), so 3 > 0 — task completes.
    assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
    // After cap (min(99,3)=3) and decrement in enterCallContext (3−1=2),
    // the child AGENT_MESH_DEPTH must be ≤ 2, never 98.
    const text = task.status.message?.parts?.[0]?.text ?? '';
    const m = text.match(/depth:(\d+)/);
    assert.ok(m, `Expected depth:N in summary, got: "${text}"`);
    assert.ok(parseInt(m[1], 10) <= 2, `Capped depth propagated ${m[1]} — exceeds DEFAULT_DEPTH − 1`);
  } finally {
    await server.close();
  }
});

test('HttpClientSession threads caller recursion env in headers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-http-hdr-'));
  await writeFile(join(root, 'AGENT.md'), 'Owns header threading tests.');
  const { server, url } = await startHttpServer(root);
  try {
    // Client env has AGENT_MESH_DEPTH=0 — should cause depth_budget on the server.
    const client = await createA2AClient(
      { remote: { url } },
      { env: { AGENT_MESH_DEPTH: '0' } }
    );
    const task = await client.send('remote', {
      messageId: 'm-hdr',
      role: 'ROLE_USER',
      parts: [{ text: 'test' }],
      metadata: { 'agentmesh/mode': 'ask' }
    });
    assert.equal(task.status.state, 'TASK_STATE_REJECTED');
    assert.equal(task.metadata['agentmesh/error_code'], 'depth_budget');
    await client.close();
  } finally {
    await server.close();
  }
});
