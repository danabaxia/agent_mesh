import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScheduler } from '../src/schedule/scheduler.js';
import { initMesh } from '../src/builder/init-mesh.js';
import { writeManifest } from '../src/builder/manifest.js';

async function meshDueJob() {
  const root = await mkdtemp(join(tmpdir(), 'sched-hook-'));
  await initMesh(root);
  const a = join(root, 'orchestrator');
  await mkdir(join(a, '.agent'), { recursive: true });
  await writeFile(join(a, '.agent', 'schedule.json'), JSON.stringify({ jobs: [{ id: 'p', name: 'poll', kind: 'builtin', builtin: 'probe', cadence: { kind: 'every', minutes: 5 }, enabled: true }] }), 'utf8');
  await writeManifest(root, { meshVersion: '0.1.0', agents: [{ name: 'orchestrator', root: './orchestrator', card: 'agent.json', served: true, enabledModes: ['ask'], peers: [] }] });
  await mkdir(join(a, '.agent-mesh'), { recursive: true });
  await writeFile(join(a, '.agent-mesh', 'schedule-state.json'), JSON.stringify({ p: { nextRunAt: '2000-01-01T00:00:00Z' } }), 'utf8');
  return root;
}

test('onJobResult fires once per scheduled job run with agent/job/status', async () => {
  const root = await meshDueJob();
  const seen = [];
  const sched = createScheduler({
    meshRoot: root,
    builtins: { probe: async () => ({ status: 'ok', output: 'done' }) },
    onJobResult: (info) => seen.push(info),
    now: () => new Date('2026-06-19T00:00:00Z'),
  });
  await sched.tick();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].agentName, 'orchestrator');
  assert.equal(seen[0].jobId, 'p');
  assert.equal(seen[0].status, 'ok');
});

test('a throwing onJobResult does not break the tick', async () => {
  const root = await meshDueJob();
  const sched = createScheduler({
    meshRoot: root,
    builtins: { probe: async () => ({ status: 'ok' }) },
    onJobResult: () => { throw new Error('boom'); },
    now: () => new Date('2026-06-19T00:00:00Z'),
  });
  await assert.doesNotReject(sched.tick());
});
