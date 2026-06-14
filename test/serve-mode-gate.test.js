/**
 * test/serve-mode-gate.test.js
 *
 * Tests for Increment 3b: serve-a2a self-check + two-layer mode gate (mode_disabled).
 * Covers:
 *   - mode_disabled in ERROR_CODES
 *   - buildAgentCard reflects agent.json x-agentmesh.modes
 *   - Capability gate (standalone, no env needed)
 *   - Policy gate (AGENT_MESH_ENABLED_MODES env)
 *   - Startup self-check (warn-and-serve default; --strict refuses on fail)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { chmod, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ERROR_CODES, buildAgentCard, buildRejectedTask } from '../src/a2a/protocol.js';
import { createA2AStdioServer } from '../src/a2a/stdio-server.js';

// ---------------------------------------------------------------------------
// 1. mode_disabled is in ERROR_CODES
// ---------------------------------------------------------------------------

test('mode_disabled is a member of the closed ERROR_CODES set', () => {
  assert.ok(ERROR_CODES.has('mode_disabled'), 'ERROR_CODES must contain "mode_disabled"');
});

test('buildRejectedTask with mode_disabled produces a rejected Task with the correct error_code', () => {
  const task = buildRejectedTask({
    id: 'test-mode',
    code: 'mode_disabled',
    message: 'Mode "do" is not allowed.',
    requestMessage: { messageId: 'm1' }
  });

  assert.equal(task.status.state, 'TASK_STATE_REJECTED');
  assert.equal(task.metadata['agentmesh/error_code'], 'mode_disabled');
});

// ---------------------------------------------------------------------------
// 2. buildAgentCard reflects agent.json x-agentmesh.modes
// ---------------------------------------------------------------------------

test('buildAgentCard uses x-agentmesh.modes from agent.json self object when present', () => {
  const card = buildAgentCard({
    self: {
      name: 'ask-only-agent',
      description: 'An ask-only agent.',
      'x-agentmesh': { modes: ['ask'] }
    },
    root: '/tmp/ask-only',
    url: 'stdio:/tmp/ask-only'
  });

  assert.deepEqual(card['x-agentmesh'].modes, ['ask']);
});

test('buildAgentCard falls back to ["ask","do"] when agent.json does not declare x-agentmesh.modes', () => {
  const card = buildAgentCard({
    self: {
      name: 'legacy-agent',
      description: 'No modes declared.'
    },
    root: '/tmp/legacy',
    url: 'stdio:/tmp/legacy'
  });

  assert.deepEqual(card['x-agentmesh'].modes, ['ask', 'do']);
});

test('buildAgentCard explicit modes param overrides agent.json x-agentmesh.modes', () => {
  const card = buildAgentCard({
    self: {
      name: 'agent',
      description: 'Has modes in agent.json',
      'x-agentmesh': { modes: ['ask'] }
    },
    root: '/tmp/agent',
    url: 'stdio:/tmp/agent',
    modes: ['ask', 'do']
  });

  assert.deepEqual(card['x-agentmesh'].modes, ['ask', 'do']);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function startServer(root, env, opts = {}) {
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

  const server = await createA2AStdioServer({ root, env, ...opts });
  const running = server.start(input, output);

  return {
    input,
    messages,
    write(message) {
      input.write(`${JSON.stringify(message)}\n`);
    },
    async stop(minMessages = 1) {
      const deadline = Date.now() + 2000;
      while (messages.length < minMessages && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      input.end();
      await running;
    }
  };
}

function makeAskOnlyFolder(root) {
  return writeFile(
    join(root, 'agent.json'),
    JSON.stringify({
      name: 'ask-only',
      description: 'Ask-only agent.',
      'x-agentmesh': { modes: ['ask'] }
    })
  );
}

function makeAskDoFolder(root) {
  return writeFile(
    join(root, 'agent.json'),
    JSON.stringify({
      name: 'ask-do-agent',
      description: 'Full capability agent.',
      'x-agentmesh': { modes: ['ask', 'do'] }
    })
  );
}

// ---------------------------------------------------------------------------
// 3. Capability gate — always on, even standalone (no env set)
// ---------------------------------------------------------------------------

test('capability gate: ask-only agent rejects do request with mode_disabled (no env set)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-mode-cap-'));
  await writeFile(join(root, 'AGENT.md'), 'Ask-only agent.');
  await makeAskOnlyFolder(root);

  const harness = await startServer(root, {});
  harness.write({
    jsonrpc: '2.0',
    id: 1,
    method: 'SendMessage',
    params: {
      message: {
        messageId: 'm1',
        role: 'ROLE_USER',
        parts: [{ text: 'Write something.' }],
        metadata: { 'agentmesh/mode': 'do' }
      }
    }
  });
  await harness.stop();

  const task = harness.messages[0].result.task;
  assert.equal(task.status.state, 'TASK_STATE_REJECTED');
  assert.equal(task.metadata['agentmesh/error_code'], 'mode_disabled');
});

test('capability gate: ask-only agent accepts ask request (no env set, no spawn needed for rejection test)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-mode-cap-ask-'));
  await writeFile(join(root, 'AGENT.md'), 'Ask-only agent.');
  await makeAskOnlyFolder(root);

  // Use a stub claude that succeeds immediately
  const fakeClaude = join(root, 'fake-claude.mjs');
  await writeFile(fakeClaude, "#!/usr/bin/env node\nconsole.log('ask ok');\n");
  await chmod(fakeClaude, 0o755);

  const harness = await startServer(root, { AGENT_MESH_CLAUDE: fakeClaude });
  harness.write({
    jsonrpc: '2.0',
    id: 1,
    method: 'SendMessage',
    params: {
      message: {
        messageId: 'm2',
        role: 'ROLE_USER',
        parts: [{ text: fakeClaude }],
        metadata: { 'agentmesh/mode': 'ask' }
      }
    }
  });
  await harness.stop();

  const task = harness.messages[0].result.task;
  assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
});

test('capability gate: no agent.json modes → no capability restriction (back-compat)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-mode-noagent-'));
  await writeFile(join(root, 'AGENT.md'), 'Legacy agent.');
  // No agent.json → agentModes === null → no capability gating
  const fakeClaude = join(root, 'fake-claude.mjs');
  await writeFile(fakeClaude, "#!/usr/bin/env node\nconsole.log('done');\n");
  await chmod(fakeClaude, 0o755);

  const harness = await startServer(root, { AGENT_MESH_CLAUDE: fakeClaude });
  harness.write({
    jsonrpc: '2.0',
    id: 1,
    method: 'SendMessage',
    params: {
      message: {
        messageId: 'm3',
        role: 'ROLE_USER',
        parts: [{ text: fakeClaude }],
        metadata: { 'agentmesh/mode': 'ask' }
      }
    }
  });
  await harness.stop();

  const task = harness.messages[0].result.task;
  assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
});

test('initialize response reflects ask-only modes in the AgentCard', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-mode-card-'));
  await writeFile(join(root, 'AGENT.md'), 'Ask-only agent.');
  await makeAskOnlyFolder(root);

  const harness = await startServer(root, {});
  harness.write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await harness.stop();

  const modes = harness.messages[0].result.agentCard['x-agentmesh'].modes;
  assert.deepEqual(modes, ['ask']);
});

// ---------------------------------------------------------------------------
// 4. Policy gate — AGENT_MESH_ENABLED_MODES env
// ---------------------------------------------------------------------------

test('policy gate: AGENT_MESH_ENABLED_MODES=ask rejects do request with mode_disabled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-mode-policy-'));
  await writeFile(join(root, 'AGENT.md'), 'Policy-gated agent.');
  // No agent.json so capability gate is inactive; only policy gate applies
  const harness = await startServer(root, { AGENT_MESH_ENABLED_MODES: 'ask' });
  harness.write({
    jsonrpc: '2.0',
    id: 1,
    method: 'SendMessage',
    params: {
      message: {
        messageId: 'm4',
        role: 'ROLE_USER',
        parts: [{ text: 'Write something.' }],
        metadata: { 'agentmesh/mode': 'do' }
      }
    }
  });
  await harness.stop();

  const task = harness.messages[0].result.task;
  assert.equal(task.status.state, 'TASK_STATE_REJECTED');
  assert.equal(task.metadata['agentmesh/error_code'], 'mode_disabled');
});

test('policy gate: AGENT_MESH_ENABLED_MODES absent → no policy gating (back-compat)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-mode-policy-absent-'));
  await writeFile(join(root, 'AGENT.md'), 'No policy agent.');
  // agent.json with both modes, env has NO AGENT_MESH_ENABLED_MODES
  await makeAskDoFolder(root);
  const fakeClaude = join(root, 'fake-claude.mjs');
  await writeFile(fakeClaude, "#!/usr/bin/env node\nconsole.log('done');\n");
  await chmod(fakeClaude, 0o755);

  // env object without the key
  const harness = await startServer(root, { AGENT_MESH_CLAUDE: fakeClaude });
  harness.write({
    jsonrpc: '2.0',
    id: 1,
    method: 'SendMessage',
    params: {
      message: {
        messageId: 'm5',
        role: 'ROLE_USER',
        parts: [{ text: fakeClaude }],
        metadata: { 'agentmesh/mode': 'ask' }
      }
    }
  });
  await harness.stop();

  const task = harness.messages[0].result.task;
  assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
});

test('policy gate: AGENT_MESH_ENABLED_MODES="" (present-but-empty) → all modes rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-mode-policy-empty-'));
  await writeFile(join(root, 'AGENT.md'), 'All-modes-blocked agent.');
  // No agent.json, env present-but-empty → all modes rejected
  const harness = await startServer(root, { AGENT_MESH_ENABLED_MODES: '' });
  harness.write({
    jsonrpc: '2.0',
    id: 1,
    method: 'SendMessage',
    params: {
      message: {
        messageId: 'm6',
        role: 'ROLE_USER',
        parts: [{ text: 'ask something.' }],
        metadata: { 'agentmesh/mode': 'ask' }
      }
    }
  });
  await harness.stop();

  const task = harness.messages[0].result.task;
  assert.equal(task.status.state, 'TASK_STATE_REJECTED');
  assert.equal(task.metadata['agentmesh/error_code'], 'mode_disabled');
});

// ---------------------------------------------------------------------------
// 5. Startup self-check
// ---------------------------------------------------------------------------

test('self-check: starting serve-a2a on a drifted folder (missing anatomy) warns and still serves', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-self-check-'));
  // No agent.json, no prompts/system.md — drifted
  await writeFile(join(root, 'AGENT.md'), 'Drifted agent.');

  // Capture stderr
  const stderrLines = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (data, ...args) => {
    stderrLines.push(typeof data === 'string' ? data : data.toString());
    return origWrite(data, ...args);
  };

  let server;
  try {
    server = await createA2AStdioServer({ root, env: {} });
  } finally {
    process.stderr.write = origWrite;
  }

  // Server was created (didn't throw)
  assert.ok(server, 'Server must start in default (warn) mode even on drifted folder');

  // Should have logged at least one conformance warning to stderr
  const allStderr = stderrLines.join('');
  assert.ok(
    allStderr.includes('[agent-mesh]') || allStderr.includes('conformance'),
    `Expected a conformance warning on stderr. Got: ${JSON.stringify(allStderr)}`
  );
});

test('self-check: --strict flag causes createA2AStdioServer to throw on conformance fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-strict-'));
  // No agent.json, no prompts/system.md — drifted folder
  await writeFile(join(root, 'AGENT.md'), 'Drifted agent.');

  await assert.rejects(
    async () => {
      await createA2AStdioServer({ root, env: {}, strict: true });
    },
    (err) => {
      assert.ok(err.message.includes('--strict'), `Expected --strict in error message, got: ${err.message}`);
      return true;
    }
  );
});

test('self-check: --strict does not block a conformant folder (prompts/system.md + agent.json present)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-strict-ok-'));
  await writeFile(join(root, 'AGENT.md'), 'Good agent.');
  await writeFile(join(root, 'agent.json'), JSON.stringify({
    name: 'good-agent',
    description: 'Conformant agent.',
    'x-agentmesh': { modes: ['ask', 'do'], meshVersion: '0.1.0' }
  }));
  await mkdir(join(root, 'prompts'), { recursive: true });
  await writeFile(join(root, 'prompts', 'system.md'), 'You are a good agent.');

  // Should NOT throw
  let server;
  try {
    server = await createA2AStdioServer({ root, env: {}, strict: true });
  } catch (err) {
    assert.fail(`Strict server threw on conformant folder: ${err.message}`);
  }
  assert.ok(server, 'Server should have started successfully');
});
