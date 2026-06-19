import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScheduler } from '../src/schedule/scheduler.js';
import { initMesh } from '../src/builder/init-mesh.js';
import { writeManifest } from '../src/builder/manifest.js';

async function meshWithDueJob() {
  const root = await mkdtemp(join(tmpdir(), 'sched-failcount-'));
  await initMesh(root);
  const a = join(root, 'orchestrator');
  await mkdir(join(a, '.agent'), { recursive: true });
  await writeFile(join(a, '.agent', 'schedule.json'),
    JSON.stringify({ jobs: [{ id: 'p', name: 'poll', kind: 'builtin', builtin: 'probe', cadence: { kind: 'every', minutes: 5 }, enabled: true }] }), 'utf8');
  await writeManifest(root, { meshVersion: '0.1.0', agents: [{ name: 'orchestrator', root: './orchestrator', card: 'agent.json', served: true, enabledModes: ['ask'], peers: [] }] });
  await mkdir(join(a, '.agent-mesh'), { recursive: true });
  await writeFile(join(a, '.agent-mesh', 'schedule-state.json'), JSON.stringify({ p: { nextRunAt: '2000-01-01T00:00:00Z' } }), 'utf8');
  return { root, statePath: join(a, '.agent-mesh', 'schedule-state.json') };
}
const readState = async (p) => JSON.parse(await readFile(p, 'utf8'));

test('consecutiveFailures increments on fail, resets on ok, defaults to 0', async () => {
  const { root, statePath } = await meshWithDueJob();
  let outcome = { status: 'fail', error: 'boom' };
  const sched = createScheduler({
    meshRoot: root,
    builtins: { probe: async () => outcome },
    now: () => new Date('2026-06-18T00:00:00Z')
  });

  await sched.tick();
  let st = await readState(statePath);
  assert.equal(st.p.lastStatus, 'fail');
  assert.equal(st.p.consecutiveFailures, 1);

  st.p.nextRunAt = '2000-01-01T00:00:00Z'; await writeFile(statePath, JSON.stringify(st), 'utf8');
  await sched.tick();
  st = await readState(statePath);
  assert.equal(st.p.consecutiveFailures, 2);

  outcome = { status: 'ok', output: 'fine' };
  st.p.nextRunAt = '2000-01-01T00:00:00Z'; await writeFile(statePath, JSON.stringify(st), 'utf8');
  await sched.tick();
  st = await readState(statePath);
  assert.equal(st.p.lastStatus, 'ok');
  assert.equal(st.p.consecutiveFailures, 0);
});
