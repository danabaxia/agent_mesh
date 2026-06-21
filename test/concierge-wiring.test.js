import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MESH = join('dev-mesh', 'mesh.json');

test('concierge is registered as a served ask-only agent with monitoring peers', () => {
  const m = JSON.parse(readFileSync(MESH, 'utf8'));
  const c = m.agents.find((a) => a.name === 'concierge');
  assert.ok(c, 'concierge in mesh.json');
  assert.equal(c.served, true);
  assert.deepEqual(c.enabledModes, ['ask']);
  for (const p of ['tester', 'triager', 'analyst']) assert.ok(c.peers.includes(p), `peer ${p}`);
});

test('concierge agent.json is ask-only', () => {
  const a = JSON.parse(readFileSync(join('dev-mesh', 'agents', 'concierge', 'agent.json'), 'utf8'));
  assert.equal(a.name, 'concierge');
  assert.deepEqual(a['x-agentmesh'].modes, ['ask']);
});

test('concierge schedule runs the monitor sweep', () => {
  const s = JSON.parse(readFileSync(join('dev-mesh', 'agents', 'concierge', '.agent', 'schedule.json'), 'utf8'));
  const job = s.jobs.find((j) => j.builtin === 'concierge-monitor-sweep');
  assert.ok(job && job.kind === 'builtin' && job.enabled);
});
