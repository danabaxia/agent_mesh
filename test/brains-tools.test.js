import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('exposes exactly the five ask-only tools', () => {
  const names = adapters().specs.map((s) => s.name).sort();
  assert.deepEqual(names, ['ask_peer', 'brainstorm_seeds', 'list_mesh_agents', 'mesh_status', 'propose_idea']);
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

// The DEFAULT list backend (no deps.listAgents injected) must read the SAME
// marker-validated registry ask_peer uses — regression for the concierge
// reporting "no agents registered" while ask_peer could still see them.
test('default list_mesh_agents reads the marker-validated registry peers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'concierge-listpeers-'));
  writeFileSync(join(dir, 'registry.json'), JSON.stringify({
    'x-agentmesh-generated': true,
    peers: {
      coder: { url: 'http://127.0.0.1:8791/rpc' },
      tester: { url: 'http://127.0.0.1:8793/rpc' },
      analyst: { url: 'http://127.0.0.1:8795/rpc' },
    },
  }));
  const { dispatch } = buildToolAdapters({ root: dir, env: {}, callEnv: {}, deps: {} });
  const r = await dispatch('list_mesh_agents', {});
  const names = r.agents.map((a) => a.name).sort();
  assert.deepEqual(names, ['analyst', 'coder', 'tester']);
});

// A markerless / stale registry must NOT be surfaced as peers (same strict rule
// the bridge enforces — registry is the only peer source, marker required).
test('default list_mesh_agents ignores a markerless registry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'concierge-nomarker-'));
  writeFileSync(join(dir, 'registry.json'), JSON.stringify({
    peers: { coder: { url: 'http://127.0.0.1:8791/rpc' } },
  }));
  const { dispatch } = buildToolAdapters({ root: dir, env: {}, callEnv: {}, deps: {} });
  const r = await dispatch('list_mesh_agents', {});
  assert.deepEqual(r.agents, []);
});

test('brainstorm_seeds returns digest seeds and filters by topic', async () => {
  const seeds = [{ theme: 'voice latency', spark: 'cache STT' }, { theme: 'docs', spark: 'auto-changelog' }];
  const { dispatch } = buildToolAdapters({ root: '/tmp/agent', env: {}, callEnv: {}, deps: {
    brainstorm: async ({ topic }) => ({ seeds: topic ? seeds.filter((s) => (s.theme + s.spark).includes(topic)) : seeds, generatedAt: 'z', degraded: [] }),
  }});
  const all = await dispatch('brainstorm_seeds', {});
  assert.equal(all.seeds.length, 2);
  const filtered = await dispatch('brainstorm_seeds', { topic: 'voice' });
  assert.equal(filtered.seeds.length, 1);
  assert.equal(filtered.seeds[0].spark, 'cache STT');
});

test('brainstorm_seeds default backend degrades to {seeds:[]} on read failure', async () => {
  const { dispatch } = buildToolAdapters({ root: '/tmp/agent', env: {}, callEnv: {}, deps: {
    brainstorm: async () => { throw new Error('offline'); },
  }});
  const r = await dispatch('brainstorm_seeds', {});
  assert.deepEqual(r.seeds, []);
});

test('unknown tool is rejected, not thrown', async () => {
  assert.deepEqual(await adapters().dispatch('rm_rf', {}), { error: 'unknown_tool' });
});

test('a backend error becomes data, never throws the loop', async () => {
  const { dispatch } = adapters({ meshStatus: async () => { throw new Error('gh down'); } });
  const r = await dispatch('mesh_status', {});
  assert.match(r.error, /gh down/);
});
