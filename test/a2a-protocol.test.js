import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAgentCard,
  buildRejectedTask,
  buildTaskFromDelegateResult,
  validateMessageSendParams
} from '../src/a2a/protocol.js';

test('buildTaskFromDelegateResult: timeout results carry agentmesh/error_code=timeout (a2a audit gap 2026-06-12)', () => {
  // A 613s timeout logged status=failed with error_code=null — timeouts have
  // no result.error.code, so the metadata never carried a code. Failure triage
  // needs timeouts distinguishable from spawn/other errors.
  const task = buildTaskFromDelegateResult({
    result: { status: 'timeout', summary: 'Timed out before producing output.', files_changed: [], log_path: 'x' },
    message: { messageId: 'm1' }
  });
  assert.equal(task.status.state, 'TASK_STATE_FAILED');
  assert.equal(task.metadata['agentmesh/error_code'], 'timeout');
});

test('validateMessageSendParams accepts A2A v1.0 text message with agentmesh mode metadata', () => {
  const result = validateMessageSendParams({
    message: {
      messageId: 'm1',
      role: 'ROLE_USER',
      parts: [{ text: 'inspect local files' }],
      metadata: { 'agentmesh/mode': 'ask', 'agentmesh/depth': 99 }
    }
  });

  assert.deepEqual(result, {
    ok: true,
    value: {
      message: {
        messageId: 'm1',
        role: 'ROLE_USER',
        parts: [{ text: 'inspect local files' }],
        metadata: { 'agentmesh/mode': 'ask', 'agentmesh/depth': 99 }
      },
      input: { mode: 'ask', task: 'inspect local files' },
      metadata: { 'agentmesh/mode': 'ask', 'agentmesh/depth': 99 }
    }
  });
});

test('validateMessageSendParams rejects malformed params as bad input data', () => {
  assert.equal(validateMessageSendParams(null).ok, false);
  assert.equal(validateMessageSendParams({ message: { parts: [] } }).ok, false);
  assert.equal(
    validateMessageSendParams({
      message: {
        parts: [{ text: 'x' }],
        metadata: { 'agentmesh/mode': 'write' }
      }
    }).ok,
    false
  );
});

test('buildTaskFromDelegateResult maps delegate outcomes onto A2A v1.0 Task objects', () => {
  const task = buildTaskFromDelegateResult({
    id: 't1',
    message: { messageId: 'm1' },
    metrics: { total_ms: 12 },
    result: {
      status: 'done',
      summary: 'finished',
      files_changed: ['file.txt'],
      log_path: '/tmp/log.json'
    }
  });

  // v1.0: no `kind` discriminator anywhere on the Task.
  assert.equal('kind' in task, false);
  assert.equal(task.contextId, 'm1');
  assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
  // ISO-8601 status timestamp is required in v1.0.
  assert.ok(!Number.isNaN(Date.parse(task.status.timestamp)));
  // Parts are discriminated by member name — text part has no `kind`.
  assert.deepEqual(task.artifacts[0].parts[0], { text: 'finished' });
  assert.equal(task.status.message.role, 'ROLE_AGENT');
  assert.deepEqual(task.metadata['agentmesh/files_changed'], ['file.txt']);
  assert.equal(task.metadata['agentmesh/log_path'], '/tmp/log.json');
  assert.equal(task.metadata['agentmesh/metrics'].total_ms, 12);
});

test('buildRejectedTask returns rejection as Task data with namespaced error metadata', () => {
  const task = buildRejectedTask({
    id: 'r1',
    code: 'bad_input',
    message: 'bad request',
    requestMessage: { messageId: 'm1' }
  });

  assert.equal(task.status.state, 'TASK_STATE_REJECTED');
  assert.equal(task.metadata['agentmesh/error_code'], 'bad_input');
  assert.equal(task.metadata['agentmesh/files_changed'], null);
});

test('buildAgentCard exposes the v1.0 A2A card fields and x-agentmesh extension', () => {
  const card = buildAgentCard({
    self: { name: 'agent-b', description: 'Owns tests.', capabilities: ['tests'] },
    root: '/tmp/agent-b',
    url: 'stdio:agent-b'
  });

  assert.equal(card.name, 'agent-b');
  // v1.0: top-level protocolVersion/url/preferredTransport are gone; the
  // ordered supportedInterfaces list carries them (first = preferred).
  assert.equal('protocolVersion' in card, false);
  assert.equal('url' in card, false);
  assert.equal('preferredTransport' in card, false);
  assert.deepEqual(card.supportedInterfaces, [
    { url: 'stdio:agent-b', protocolBinding: 'STDIO', protocolVersion: '1.0' }
  ]);
  assert.deepEqual(card.capabilities, {
    streaming: false,
    pushNotifications: false,
    stateTransitionHistory: false,
    extendedAgentCard: false
  });
  assert.deepEqual(card.defaultInputModes, ['text/plain']);
  assert.equal(card.skills[0].tags.includes('tests'), true);
  assert.deepEqual(card['x-agentmesh'].modes, ['ask', 'do']);
});
