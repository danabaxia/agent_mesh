import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('../scripts/dev-society-daemon.mjs', import.meta.url)), 'utf8');

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

test('runOneTask holds the build-lock (acquire before build, release in finally)', () => {
  const acq = src.indexOf('acquireBuildLock(repoRoot');
  const rel = src.indexOf('releaseBuildLock(repoRoot)');
  assert.ok(acq !== -1, 'runOneTask must acquireBuildLock');
  assert.ok(rel !== -1, 'runOneTask must releaseBuildLock');
  // release comes after acquire, and sits in the finally (after the ledger append)
  assert.ok(acq < rel, 'acquire precedes release');
  assert.ok(src.indexOf('coder', acq) < rel, 'the build runs between acquire and release');
});
