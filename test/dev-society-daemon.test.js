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
