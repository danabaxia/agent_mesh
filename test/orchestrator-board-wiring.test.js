import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('orchestrator is wired as the board team lead', () => {
  const m = JSON.parse(readFileSync(join('dev-mesh', 'mesh.json'), 'utf8'));
  const o = m.agents.find((a) => a.name === 'orchestrator');
  assert.ok(o, 'orchestrator in mesh.json');
  for (const p of ['analyst', 'coder', 'tester', 'reviewer']) assert.ok(o.peers.includes(p), `team peer ${p}`);
  assert.deepEqual(o.enabledModes, ['ask']);   // still ask-only
});

test('orchestrator has the board-drive delegate job', () => {
  const s = JSON.parse(readFileSync(join('dev-mesh', 'orchestrator', '.agent', 'schedule.json'), 'utf8'));
  const job = s.jobs.find((j) => j.id === 'board-drive');
  assert.ok(job, 'board-drive job present');
  assert.equal(job.kind, 'delegate');
  assert.equal(job.enabled, true);
  assert.equal(job.cadence.kind, 'every');
  assert.ok(/list_my_tasks/.test(job.prompt) && /fanOutToPeers|delegate_to_peer/.test(job.prompt) && /update_my_task/.test(job.prompt),
    'prompt drives the team workflow');
});

test('orchestrator AGENT.md describes the team-lead role', () => {
  const md = readFileSync(join('dev-mesh', 'orchestrator', 'AGENT.md'), 'utf8');
  assert.ok(/team lead|team-lead/i.test(md));
});

test('concierge persona routes substantive work to the orchestrator', () => {
  const md = readFileSync(join('dev-mesh', 'concierge', 'AGENT.md'), 'utf8');
  assert.ok(/orchestrator/.test(md), 'concierge persona names the orchestrator as the work target');
  const m = JSON.parse(readFileSync(join('dev-mesh', 'mesh.json'), 'utf8'));
  assert.ok(m.agents.find((a) => a.name === 'concierge').peers.includes('orchestrator'));
});
