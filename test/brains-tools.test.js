import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildToolAdapters } from '../src/brains/tools.js';

function adapters(overrides = {}) {
  return buildToolAdapters({
    root: '/tmp/agent', env: {}, callEnv: {},
    deps: {
      meshStatus: async () => ({ open_issues: 2 }),
      listAgents: async () => ['tester', 'analyst'],
      askPeer: async ({ agent, question }) => ({ answer: `ask(${agent}):${question}` }),
      ...overrides,
    },
  });
}

test('exposes exactly the four ask-only tools', () => {
  const names = adapters().specs.map((s) => s.name).sort();
  assert.deepEqual(names, ['ask_peer', 'list_mesh_agents', 'mesh_status', 'propose_idea']);
});

test('propose_idea returns enrichment and performs NO write', async () => {
  const { dispatch } = adapters();
  const r = await dispatch('propose_idea', { title: 'Cache STT', note: 'warm pool' });
  assert.deepEqual(r.__enrichment, { idea: { title: 'Cache STT', note: 'warm pool' } });
  assert.equal(r.ok, true);
});

test('ask_peer routes through the injected askPeer backend', async () => {
  const { dispatch } = adapters();
  const r = await dispatch('ask_peer', { agent: 'tester', question: 'status?' });
  assert.equal(r.answer, 'ask(tester):status?');
});

test('mesh_status / list_mesh_agents call their read backends', async () => {
  const { dispatch } = adapters();
  assert.deepEqual(await dispatch('mesh_status', {}), { open_issues: 2 });
  assert.deepEqual(await dispatch('list_mesh_agents', {}), { agents: ['tester', 'analyst'] });
});

test('unknown tool is rejected, not thrown', async () => {
  assert.deepEqual(await adapters().dispatch('rm_rf', {}), { error: 'unknown_tool' });
});

test('a backend error becomes data, never throws the loop', async () => {
  const { dispatch } = adapters({ meshStatus: async () => { throw new Error('gh down'); } });
  const r = await dispatch('mesh_status', {});
  assert.match(r.error, /gh down/);
});
