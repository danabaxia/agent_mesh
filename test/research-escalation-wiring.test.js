import { test } from 'node:test';
import assert from 'node:assert/strict';
import { a2aMessage, advisoryRegistry, routeFor } from '../src/dev-society/core.js';
import { join } from 'node:path';

test('a2aMessage: string 3rd arg is still treated as messageId (back-compat)', () => {
  const m = a2aMessage('ask', 'hello', 'mid-1');
  assert.equal(m.messageId, 'mid-1');
  assert.equal(m.metadata['agentmesh/mode'], 'ask');
  assert.equal(m.metadata['agentmesh/caller'], undefined);
  assert.deepEqual(m.parts, [{ text: 'hello' }]);
});

test('a2aMessage: options object with caller stamps agentmesh/caller', () => {
  const m = a2aMessage('ask', 'hi', { caller: 'research-escalation:issue-7' });
  assert.equal(m.metadata['agentmesh/caller'], 'research-escalation:issue-7');
  assert.equal(m.metadata['agentmesh/mode'], 'ask');
  assert.ok(typeof m.messageId === 'string' && m.messageId.length > 0);
});

test('a2aMessage: options object with messageId honored', () => {
  const m = a2aMessage('ask', 'hi', { messageId: 'mid-2', caller: 'c' });
  assert.equal(m.messageId, 'mid-2');
  assert.equal(m.metadata['agentmesh/caller'], 'c');
});

test('advisoryRegistry: each peer env stamps mesh-root + ceiling for web-tools resolution', () => {
  const reg = advisoryRegistry({ binPath: '/x/bin/agent-mesh.js', meshRoot: '/m/dev-mesh' });
  for (const name of ['analyst', 'triager']) {
    const env = reg.peers[name].env;
    assert.equal(env.AGENT_MESH_ENABLED_MODES, 'ask');
    assert.equal(env.AGENT_MESH_MESH_ROOT, join('/m/dev-mesh', 'mesh'));
    assert.equal(env.AGENT_MESH_MESH_CEILING, '/m/dev-mesh');
  }
});

const iss = (labels, title = 'x') => ({ number: 1, title, labels: labels.map((name) => ({ name })) });

test('routeFor: needs-human issue is skipped (research-owned), not routed to triager', () => {
  const r = routeFor(iss(['needs-human']));
  assert.equal(r.target, null);
  assert.equal(r.reason, 'needs-human-research-owned');
});

test('routeFor: needs-human + a code label is still skipped (research owns the escalation)', () => {
  const r = routeFor(iss(['needs-human', 'bug']));
  assert.equal(r.target, null);
  assert.equal(r.reason, 'needs-human-research-owned');
});

test('routeFor: an unlabeled issue still falls through to triage (skip is scoped)', () => {
  const r = routeFor(iss([]));
  assert.equal(r.target, 'triager');
  assert.equal(r.reason, 'triage');
});
