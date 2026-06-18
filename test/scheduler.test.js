/**
 * test/scheduler.test.js — src/dashboard/scheduler.js (Phase-5 Task 2).
 *
 * Hermetic temp meshes (initMesh + writeManifest + one agent folder carrying
 * .agent/schedule.json). No HTTP server, no real timers: runJob is an injected
 * recording stub and `now` is a mutable fake clock; tick() is called manually.
 *
 * runJob contract (scheduler-internal): async ({agentRoot, agentName, job}) →
 * {status:'ok'|'fail', output?:string, error?:string}; a rejection counts as
 * fail. The default (non-injected) runJob wraps delegateTask and maps its
 * status:'done' → ok / everything else → fail — covered by Task-5 live E2E.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScheduler } from '../src/schedule/scheduler.js';
import { computeNextRun } from '../src/schedule/schedule-cadence.js';
import { initMesh } from '../src/builder/init-mesh.js';
import { writeManifest } from '../src/builder/manifest.js';

const EVERY10 = { kind: 'every', minutes: 10 };

async function buildMesh(jobs) {
  const meshRoot = await mkdtemp(join(tmpdir(), 'sched-'));
  await initMesh(meshRoot);
  const agentRoot = join(meshRoot, 'library');
  await mkdir(join(agentRoot, '.agent'), { recursive: true });
  await writeFile(join(agentRoot, 'agent.json'), JSON.stringify({ name: 'library' }), 'utf8');
  await writeManifest(meshRoot, {
    meshVersion: '0.1.0',
    agents: [{ name: 'library', root: './library', card: 'agent.json', served: true, enabledModes: ['ask'], peers: [] }]
  });
  if (jobs) {
    await writeFile(join(agentRoot, '.agent', 'schedule.json'), JSON.stringify({ jobs }, null, 2), 'utf8');
  }
  return { meshRoot, agentRoot };
}

function job(over = {}) {
  return {
    id: 'heartbeat-check', name: 'heartbeat check', prompt: 'reply scheduled-ok',
    cadence: EVERY10, enabled: true, saveArtifact: false, ...over
  };
}

/** Mutable fake clock starting at a fixed local instant. */
function fakeClock(iso = '2026-06-11T06:00:00') {
  let t = new Date(iso).getTime();
  const now = () => new Date(t);
  now.advanceMinutes = (m) => { t += m * 60000; };
  return now;
}

/** Recording stub: counts calls, resolves `result` (or rejects when it's an Error). */
function recordingRunJob(result = { status: 'ok', output: 'x' }) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    if (typeof result === 'function') return result(args);
    if (result instanceof Error) throw result;
    return result;
  };
  fn.calls = calls;
  return fn;
}

const readState = (agentRoot) =>
  readFile(join(agentRoot, '.agent-mesh', 'schedule-state.json'), 'utf8').then(JSON.parse);
const readDefs = (agentRoot) =>
  readFile(join(agentRoot, '.agent', 'schedule.json'), 'utf8').then(JSON.parse);

test('new job: first tick computes nextRunAt without running', async () => {
  const { meshRoot, agentRoot } = await buildMesh([job()]);
  const now = fakeClock();
  const runJob = recordingRunJob();
  const sched = createScheduler({ meshRoot, runJob, now });

  await sched.tick();

  assert.equal(runJob.calls.length, 0, 'never-run job is scheduled, not run');
  const state = await readState(agentRoot);
  const expected = computeNextRun(EVERY10, now()).toISOString();
  assert.equal(state['heartbeat-check'].nextRunAt, expected);
  assert.equal(state['heartbeat-check'].running, false);
});

test('due job: runs once, then reschedules from completion time', async () => {
  const { meshRoot, agentRoot } = await buildMesh([job()]);
  const now = fakeClock();
  const runJob = recordingRunJob({ status: 'ok', output: 'hello world' });
  const sched = createScheduler({ meshRoot, runJob, now });

  await sched.tick();                 // schedule only
  now.advanceMinutes(11);             // past nextRunAt
  await sched.tick();                 // due → run

  assert.equal(runJob.calls.length, 1);
  assert.equal(runJob.calls[0].agentName, 'library');
  assert.equal(runJob.calls[0].job.id, 'heartbeat-check');

  const state = await readState(agentRoot);
  const entry = state['heartbeat-check'];
  assert.equal(entry.lastStatus, 'ok');
  assert.equal(entry.lastSummary, 'hello world');
  assert.equal(entry.lastRunAt, now().toISOString());
  assert.equal(entry.nextRunAt, computeNextRun(EVERY10, now()).toISOString());
  assert.equal(entry.running, false);

  await sched.tick();                 // not due again yet
  assert.equal(runJob.calls.length, 1, 'no double-run before nextRunAt');
});

test('missed while down: catches up exactly ONCE, reschedules from now', async () => {
  const { meshRoot, agentRoot } = await buildMesh([job()]);
  const now = fakeClock();
  // Seed state as if the scheduler was down for 3 intervals.
  await mkdir(join(agentRoot, '.agent-mesh'), { recursive: true });
  const past = new Date(now().getTime() - 30 * 60000).toISOString();
  await writeFile(join(agentRoot, '.agent-mesh', 'schedule-state.json'),
    JSON.stringify({ 'heartbeat-check': { lastRunAt: past, lastStatus: 'ok', lastSummary: '', nextRunAt: past, running: false } }),
    'utf8');
  const runJob = recordingRunJob();
  const sched = createScheduler({ meshRoot, runJob, now });

  await sched.tick();
  assert.equal(runJob.calls.length, 1, 'missed job runs once');
  const state = await readState(agentRoot);
  assert.equal(state['heartbeat-check'].nextRunAt, computeNextRun(EVERY10, now()).toISOString(),
    'rescheduled from now, not from the stale nextRunAt');

  await sched.tick();
  assert.equal(runJob.calls.length, 1, 'no second catch-up run');
});

test('disabled job never runs (even when nextRunAt is long past)', async () => {
  const { meshRoot, agentRoot } = await buildMesh([job({ enabled: false })]);
  const now = fakeClock();
  await mkdir(join(agentRoot, '.agent-mesh'), { recursive: true });
  const past = new Date(now().getTime() - 60 * 60000).toISOString();
  await writeFile(join(agentRoot, '.agent-mesh', 'schedule-state.json'),
    JSON.stringify({ 'heartbeat-check': { nextRunAt: past, running: false } }), 'utf8');
  const runJob = recordingRunJob();
  const sched = createScheduler({ meshRoot, runJob, now });

  await sched.tick();
  now.advanceMinutes(120);
  await sched.tick();
  assert.equal(runJob.calls.length, 0);
});

test('one-at-a-time per agent: tick during an in-flight run skips; next tick runs the second job', async () => {
  const { meshRoot } = await buildMesh([
    job(),
    job({ id: 'second-job', name: 'second job' })
  ]);
  const now = fakeClock();
  let release;
  const gate = new Promise((r) => { release = r; });
  const calls = [];
  const runJob = async (args) => { calls.push(args); await gate; return { status: 'ok', output: 'done' }; };
  const sched = createScheduler({ meshRoot, runJob, now });

  await sched.tick();                 // schedule both
  now.advanceMinutes(11);             // both due
  const firstTick = sched.tick();     // starts ONE run (agent lock), do not await
  // Give the tick a beat to enter runJob before probing.
  while (calls.length === 0) await new Promise((r) => setImmediate(r));

  await sched.tick();                 // agent busy → skip entirely
  assert.equal(calls.length, 1, 'second tick during run does not start another job');

  release();
  await firstTick;

  await sched.tick();                 // lock free → the still-due second job runs
  release();                          // (same gate already resolved; harmless)
  assert.equal(calls.length, 2, 'remaining due job runs on a later tick');
  assert.notEqual(calls[0].job.id, calls[1].job.id);
});

test('runNow: bypasses schedule and enabled flag; refused while the agent is running', async () => {
  const { meshRoot, agentRoot } = await buildMesh([job({ enabled: false })]);
  const now = fakeClock();
  let release;
  const gate = new Promise((r) => { release = r; });
  const calls = [];
  const runJob = async (args) => { calls.push(args); await gate; return { status: 'ok', output: 'manual' }; };
  const sched = createScheduler({ meshRoot, runJob, now });
  // NOTE: scheduler never start()ed — runNow must work standalone.

  const p1 = sched.runNow('library', 'heartbeat-check');
  while (calls.length === 0) await new Promise((r) => setImmediate(r));
  const r2 = await sched.runNow('library', 'heartbeat-check');
  assert.equal(r2.ok, false, 'runNow while running is refused');
  assert.equal(calls.length, 1);

  release();
  const r1 = await p1;
  assert.equal(r1.ok, true);
  const state = await readState(agentRoot);
  assert.equal(state['heartbeat-check'].lastStatus, 'ok');
  assert.equal(state['heartbeat-check'].lastSummary, 'manual');
  assert.equal(state['heartbeat-check'].running, false);

  assert.equal((await sched.runNow('library', 'no-such-job')).ok, false, 'unknown job refused');
});

test('fail path: rejecting runJob → lastStatus fail, summary captured, nextRunAt still advances', async () => {
  const { meshRoot, agentRoot } = await buildMesh([job()]);
  const now = fakeClock();
  const runJob = recordingRunJob(new Error('boom: claude exploded'));
  const sched = createScheduler({ meshRoot, runJob, now });

  await sched.tick();
  now.advanceMinutes(11);
  await sched.tick();                 // due → run → reject

  assert.equal(runJob.calls.length, 1);
  const state = await readState(agentRoot);
  const entry = state['heartbeat-check'];
  assert.equal(entry.lastStatus, 'fail');
  assert.match(entry.lastSummary, /boom: claude exploded/);
  assert.equal(entry.running, false);
  assert.equal(entry.nextRunAt, computeNextRun(EVERY10, now()).toISOString(), 'failure still reschedules');
});

test('state persistence: a new createScheduler over the same mesh reads the state file', async () => {
  const { meshRoot } = await buildMesh([job()]);
  const now = fakeClock();
  const runJobA = recordingRunJob({ status: 'ok', output: 'first run' });
  const a = createScheduler({ meshRoot, runJob: runJobA, now });
  await a.tick();
  now.advanceMinutes(11);
  await a.tick();
  assert.equal(runJobA.calls.length, 1);

  const runJobB = recordingRunJob();
  const b = createScheduler({ meshRoot, runJob: runJobB, now });
  const rows = await b.list('library');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'heartbeat-check');
  assert.equal(rows[0].name, 'heartbeat check');
  assert.equal(rows[0].enabled, true);
  assert.equal(rows[0].lastStatus, 'ok');
  assert.equal(rows[0].lastSummary, 'first run');
  assert.equal(rows[0].nextRunAt, computeNextRun(EVERY10, now()).toISOString());

  await b.tick();                     // before nextRunAt → not due in the new instance
  assert.equal(runJobB.calls.length, 0, 'persisted nextRunAt honored across instances');
});

test('setEnabled: flips the def file; re-enabling recomputes nextRunAt from now', async () => {
  const { meshRoot, agentRoot } = await buildMesh([job()]);
  const now = fakeClock();
  const runJob = recordingRunJob();
  const sched = createScheduler({ meshRoot, runJob, now });
  await sched.tick();

  assert.equal((await sched.setEnabled('library', 'heartbeat-check', false)).ok, true);
  assert.equal((await readDefs(agentRoot)).jobs[0].enabled, false);
  now.advanceMinutes(60);
  await sched.tick();
  assert.equal(runJob.calls.length, 0, 'paused job skipped');

  assert.equal((await sched.setEnabled('library', 'heartbeat-check', true)).ok, true);
  assert.equal((await readDefs(agentRoot)).jobs[0].enabled, true);
  const state = await readState(agentRoot);
  assert.equal(state['heartbeat-check'].nextRunAt, computeNextRun(EVERY10, now()).toISOString(),
    're-enable recomputes nextRunAt from now (no catch-up burst)');
  assert.equal((await sched.setEnabled('library', 'nope', true)).ok, false);
});

test('saveArtifact: ok run writes a Phase-3-contract context.json + artifact.md, content capped 64KB', async () => {
  const { meshRoot, agentRoot } = await buildMesh([job({ saveArtifact: true })]);
  const now = fakeClock('2026-06-11T06:00:00');
  const bigOutput = 'A'.repeat(70 * 1024); // > 64KB cap
  const runJob = recordingRunJob({ status: 'ok', output: bigOutput });
  const sched = createScheduler({ meshRoot, runJob, now });

  await sched.tick();
  now.advanceMinutes(11);
  await sched.tick();

  const artifactsRoot = join(agentRoot, '.agent', 'artifacts');
  const dirs = await readdir(artifactsRoot);
  assert.equal(dirs.length, 1);
  assert.match(dirs[0], /^\d{4}-\d{2}-\d{2}-\d{4}-[a-z0-9-]+$/);

  const ctx = JSON.parse(await readFile(join(artifactsRoot, dirs[0], 'context.json'), 'utf8'));
  assert.equal(ctx.title, 'heartbeat check — 2026-06-11');
  assert.equal(ctx.type, 'report');
  assert.equal(ctx.task, 'heartbeat check');
  assert.equal(ctx.agent, 'library');
  assert.equal(ctx.source.kind, 'text');
  assert.equal(ctx.source.content.length, 64 * 1024, 'content capped at 64KB');
  assert.equal(ctx.promotedTo, null);
  assert.ok(!Number.isNaN(Date.parse(ctx.savedAt)), 'savedAt is ISO parseable');

  const md = await readFile(join(artifactsRoot, dirs[0], 'artifact.md'), 'utf8');
  assert.ok(md.startsWith('# heartbeat check — 2026-06-11'), 'artifact.md starts with the title');
});

test('tolerates missing schedule.json and corrupt state file; tick never throws', async () => {
  const { meshRoot, agentRoot } = await buildMesh(null); // no schedule.json at all
  const now = fakeClock();
  const runJob = recordingRunJob();
  const sched = createScheduler({ meshRoot, runJob, now });
  await sched.tick();                 // missing defs → no-op
  assert.equal(runJob.calls.length, 0);
  assert.deepEqual(await sched.list('library'), []);

  // Corrupt both files → still no throw, defs treated as empty.
  await writeFile(join(agentRoot, '.agent', 'schedule.json'), '{not json', 'utf8');
  await mkdir(join(agentRoot, '.agent-mesh'), { recursive: true });
  await writeFile(join(agentRoot, '.agent-mesh', 'schedule-state.json'), '{not json', 'utf8');
  await sched.tick();
  assert.equal(runJob.calls.length, 0);
});
