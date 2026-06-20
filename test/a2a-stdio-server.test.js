import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createA2AStdioServer } from '../src/a2a/stdio-server.js';

test('A2A stdio server initializes with an AgentCard and responds to ping', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-a2a-'));
  await writeFile(join(root, 'AGENT.md'), 'Capabilities: tests.\nOwns deterministic tests, CI integration, and coverage reporting for the project.');
  const harness = await startServer(root, {});

  harness.write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  harness.write({ jsonrpc: '2.0', id: 2, method: 'ping' });
  await harness.stop();

  assert.equal(harness.messages[0].result.agentCard.name, root.split(/[/\\]/).at(-1));
  assert.equal(harness.messages[0].result.agentCard.skills[0].tags.includes('tests'), true);
  assert.deepEqual(harness.messages[1], { jsonrpc: '2.0', id: 2, result: {} });
});

test('A2A SendMessage returns bad input as rejected Task data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-a2a-'));
  await writeFile(join(root, 'AGENT.md'), 'Owns tests.');
  const harness = await startServer(root, {});

  harness.write({
    jsonrpc: '2.0',
    id: 1,
    method: 'SendMessage',
    params: { message: { parts: [{ text: 'x' }], metadata: { 'agentmesh/mode': 'write' } } }
  });
  await harness.stop();

  // v1.0: SendMessageResponse wraps the Task as { task }.
  const task = harness.messages[0].result.task;
  assert.equal(task.status.state, 'TASK_STATE_REJECTED');
  assert.equal(task.metadata['agentmesh/error_code'], 'bad_input');
});

test('A2A SendMessage runs delegate and returns a completed Task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-a2a-'));
  await writeFile(join(root, 'AGENT.md'), 'Owns tests.');
  const fakeClaude = join(root, 'fake-claude.mjs');
  await writeFile(fakeClaude, "#!/usr/bin/env node\nconsole.log('analysis complete');\n");
  await chmod(fakeClaude, 0o755);
  const harness = await startServer(root, { AGENT_MESH_CLAUDE: fakeClaude });

  harness.write({
    jsonrpc: '2.0',
    id: 1,
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
  await harness.stop();

  const task = harness.messages[0].result.task;
  assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
  assert.equal('kind' in task, false, 'v1.0 Task has no kind discriminator');
  assert.ok(!Number.isNaN(Date.parse(task.status.timestamp)), 'v1.0 status carries an ISO-8601 timestamp');
  assert.match(task.artifacts[0].parts[0].text, /analysis complete/);
  assert.equal('kind' in task.artifacts[0].parts[0], false, 'v1.0 parts are member-discriminated');
  assert.equal(Array.isArray(task.metadata['agentmesh/files_changed']), false);
  assert.equal(typeof task.metadata['agentmesh/metrics'].total_ms, 'number');
});

test('legacy v0.3.0 message/send is rejected with JSON-RPC -32601 (no compat alias)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-a2a-'));
  await writeFile(join(root, 'AGENT.md'), 'Owns tests.');
  const harness = await startServer(root, {});

  harness.write({
    jsonrpc: '2.0',
    id: 1,
    method: 'message/send',
    params: {
      message: {
        messageId: 'm1',
        role: 'ROLE_USER',
        parts: [{ text: 'x' }],
        metadata: { 'agentmesh/mode': 'ask' }
      }
    }
  });
  await harness.stop();

  assert.equal(harness.messages[0].error.code, -32601);
});

test('A2A stdio server reserves JSON-RPC errors for protocol failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-a2a-'));
  await writeFile(join(root, 'AGENT.md'), 'Owns tests.');
  const harness = await startServer(root, {});

  harness.input.write('not json\n');
  harness.write({ jsonrpc: '2.0', id: 1, method: 'unknown' });
  await harness.stop();

  assert.equal(harness.messages[0].error.code, -32700);
  assert.equal(harness.messages[1].error.code, -32601);
});

test('A2A SendMessage notification (no id) gets no response and spawns no worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-a2a-'));
  await writeFile(join(root, 'AGENT.md'), 'Owns tests.');
  const sentinel = join(root, 'spawned.txt');
  const fakeClaude = join(root, 'fake-claude.mjs');
  await writeFile(
    fakeClaude,
    `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'x');\nconsole.log('ran');\n`
  );
  await chmod(fakeClaude, 0o755);
  const harness = await startServer(root, { AGENT_MESH_CLAUDE: fakeClaude });

  // No `id` => JSON-RPC notification.
  harness.write({
    jsonrpc: '2.0',
    method: 'SendMessage',
    params: { message: { role: 'ROLE_USER', parts: [{ text: fakeClaude }], metadata: { 'agentmesh/mode': 'ask' } } }
  });
  // A following request that DOES get answered, so we can bound the wait.
  harness.write({ jsonrpc: '2.0', id: 9, method: 'ping' });
  await harness.stop();

  assert.deepEqual(harness.messages, [{ jsonrpc: '2.0', id: 9, result: {} }]);
  assert.equal(existsSync(sentinel), false, 'a notification must not spawn a worker');
});

test('A2A server reassembles a multi-byte UTF-8 char split across input chunks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-a2a-'));
  await writeFile(join(root, 'AGENT.md'), 'Owns tests.');
  const fakeClaude = join(root, 'fake-claude.mjs');
  // Echo the -p task back so we can inspect what the server reconstructed.
  await writeFile(fakeClaude, "#!/usr/bin/env node\nconst i=process.argv.indexOf('-p');console.log(process.argv[i+1]);\n");
  await chmod(fakeClaude, 0o755);
  const harness = await startServer(root, { AGENT_MESH_CLAUDE: fakeClaude });

  const taskText = 'café ☕ déjà';
  const line = `${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'SendMessage',
    params: { message: { role: 'ROLE_USER', parts: [{ text: taskText }], metadata: { 'agentmesh/mode': 'ask' } } }
  })}\n`;
  const buf = Buffer.from(line, 'utf8');
  const cut = buf.indexOf(Buffer.from('☕', 'utf8')) + 1; // mid multi-byte sequence
  harness.input.write(buf.subarray(0, cut));
  harness.input.write(buf.subarray(cut));
  await harness.stop();

  const task = harness.messages[0].result.task;
  assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
  assert.match(task.artifacts[0].parts[0].text, /café ☕ déjà/);
});

async function startServer(root, env) {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages = [];
  let text = '';
  output.setEncoding('utf8');
  output.on('data', (chunk) => {
    text += chunk;
    let newline = text.indexOf('\n');
    while (newline !== -1) {
      const line = text.slice(0, newline).trim();
      text = text.slice(newline + 1);
      if (line) messages.push(JSON.parse(line));
      newline = text.indexOf('\n');
    }
  });

  const server = await createA2AStdioServer({ root, env });
  const running = server.start(input, output);

  return {
    input,
    messages,
    write(message) {
      input.write(`${JSON.stringify(message)}\n`);
    },
    async stop() {
      const deadline = Date.now() + 5000;
      while (messages.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      input.end();
      await running;
    }
  };
}
