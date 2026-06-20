import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('../scripts/dev-society-daemon.mjs', import.meta.url)), 'utf8');
const maintainerSchedule = JSON.parse(readFileSync(fileURLToPath(new URL('../dev-mesh/maintainer/.agent/schedule.json', import.meta.url)), 'utf8'));

test('daemon registers the analyst-daily-review builtin', () => {
  assert.match(src, /'analyst-daily-review'\s*:/);
  assert.match(src, /runAnalystDailyReview/);
});

test('daemon awaits doctor(apply,managedOnly) before sched.start()', () => {
  const doctorIdx = src.search(/doctor\(\s*SCHED_MESH_ROOT\s*,\s*\{[^}]*apply\s*:\s*true[^}]*managedOnly\s*:\s*true/);
  const startIdx = src.indexOf('sched.start()');
  assert.ok(doctorIdx !== -1, 'doctor(SCHED_MESH_ROOT,{apply:true,managedOnly:true}) call must exist');
  assert.ok(startIdx !== -1, 'sched.start() must exist');
  assert.ok(doctorIdx < startIdx, 'doctor must be called before sched.start()');
  assert.match(src, /await\s+doctor\(\s*SCHED_MESH_ROOT/);
});

test('daemon registers the automerge-sweep builtin (daemon-driven prompt drain, gated)', () => {
  assert.match(src, /'automerge-sweep'\s*:/);
  assert.match(src, /runAutomergeSweep/);
  // gated on AUTOMERGE_ENABLED — same off-by-default safety as the GitHub-Actions sweep
  assert.match(src, /enabled:\s*process\.env\.AUTOMERGE_ENABLED\s*===\s*'true'/);
});

test('maintainer schedule runs automerge-sweep every ~10min (reliable cadence, not GitHub cron)', () => {
  const job = maintainerSchedule.jobs.find((j) => j.builtin === 'automerge-sweep');
  assert.ok(job, 'automerge-sweep job must be scheduled on the maintainer');
  assert.equal(job.kind, 'builtin');
  assert.equal(job.enabled, true);
  assert.equal(job.cadence.kind, 'every');
  assert.ok(job.cadence.minutes <= 10, 'cadence must be <=10min to beat GitHub cron throttling');
});

test('daemon registers the post-merge-reconcile builtin (closes merged-but-open issues)', () => {
  assert.match(src, /'post-merge-reconcile'\s*:/);
  assert.match(src, /planPostMergeReconcile/);
  assert.match(src, /'issue',\s*'close'/, 'must close the reconciled issue');
});

test('maintainer schedule runs post-merge-reconcile every ~10min', () => {
  const job = maintainerSchedule.jobs.find((j) => j.builtin === 'post-merge-reconcile');
  assert.ok(job, 'post-merge-reconcile job must be scheduled');
  assert.equal(job.enabled, true);
  assert.equal(job.cadence.kind, 'every');
  assert.ok(job.cadence.minutes <= 10);
});

test('runOneTask holds the build-lock (acquire before build, release in finally)', () => {
  const acq = src.indexOf('acquireBuildLock(repoRoot');
  const rel = src.indexOf('releaseBuildLock(repoRoot)');
  assert.ok(acq !== -1, 'runOneTask must acquireBuildLock');
  assert.ok(rel !== -1, 'runOneTask must releaseBuildLock');
  // release comes after acquire, and sits in the finally (after the ledger append)
  assert.ok(acq < rel, 'acquire precedes release');
  assert.ok(src.indexOf('coder', acq) < rel, 'the build runs between acquire and release');
});
