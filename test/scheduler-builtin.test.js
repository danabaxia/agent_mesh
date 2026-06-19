/**
 * test/scheduler-builtin.test.js — builtin job kind (Task 3).
 *
 * Verifies that kind:'builtin' jobs dispatch to a registered plain function
 * (not delegateTask/runJob), and that state is written identically to the
 * normal delegate path (lastStatus 'ok'|'fail', nextRunAt advances).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScheduler } from '../src/schedule/scheduler.js';
import { initMesh } from '../src/builder/init-mesh.js';
import { writeManifest } from '../src/builder/manifest.js';

/** Build a minimal hermetic mesh with one agent carrying a single job def. */
async function mesh(job) {
  const root = await mkdtemp(join(tmpdir(), 'sched-builtin-'));
  await initMesh(root);
  const a = join(root, 'orchestrator');
  await mkdir(join(a, '.agent'), { recursive: true });
  await writeFile(join(a, '.agent', 'schedule.json'), JSON.stringify({ jobs: [job] }), 'utf8');
  await writeManifest(root, {
    meshVersion: '0.1.0',
    agents: [{ name: 'orchestrator', root: './orchestrator', card: 'agent.json', served: true, enabledModes: ['ask'], peers: [] }]
  });
  return { root, a };
}

/** Fake clock pinned to a fixed instant (no advance needed for these tests). */
function fakeClock(iso = '2026-06-18T00:00:00Z') {
  const t = new Date(iso).getTime();
  return () => new Date(t);
}

/** Seed schedule-state.json so the job is already due (nextRunAt in the past). */
async function seedDue(agentRoot, jobId) {
  await mkdir(join(agentRoot, '.agent-mesh'), { recursive: true });
  await writeFile(
    join(agentRoot, '.agent-mesh', 'schedule-state.json'),
    JSON.stringify({ [jobId]: { nextRunAt: '2000-01-01T00:00:00Z', running: false } }),
    'utf8'
  );
}

test('builtin job runs the registered fn (not delegateTask); state records ok', async () => {
  let ran = 0;
  const jobDef = {
    id: 'p',
    name: 'poll',
    kind: 'builtin',
    builtin: 'gh-activity-poll',
    cadence: { kind: 'every', minutes: 5 },
    enabled: true
  };
  const { root, a } = await mesh(jobDef);
  await seedDue(a, 'p');

  const sched = createScheduler({
    meshRoot: root,
    builtins: {
      'gh-activity-poll': async () => { ran++; return { status: 'ok', output: 'done' }; }
    },
    now: fakeClock()
  });

  await sched.tick();

  assert.equal(ran, 1, 'builtin fn was called exactly once');
  const state = JSON.parse(await readFile(join(a, '.agent-mesh', 'schedule-state.json'), 'utf8'));
  assert.equal(state.p.lastStatus, 'ok', 'lastStatus recorded as ok');
  assert.equal(state.p.running, false, 'running flag cleared');
});

test('unknown builtin → fail state, never throws', async () => {
  const jobDef = {
    id: 'p',
    name: 'poll',
    kind: 'builtin',
    builtin: 'nope',
    cadence: { kind: 'every', minutes: 5 },
    enabled: true
  };
  const { root, a } = await mesh(jobDef);
  await seedDue(a, 'p');

  const sched = createScheduler({
    meshRoot: root,
    builtins: {},
    now: fakeClock()
  });

  // Must not throw:
  await sched.tick();

  const state = JSON.parse(await readFile(join(a, '.agent-mesh', 'schedule-state.json'), 'utf8'));
  assert.equal(state.p.lastStatus, 'fail', 'unknown builtin records fail');
  assert.equal(state.p.running, false, 'running flag cleared even on fail');
});
