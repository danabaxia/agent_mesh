import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

test('maintainer schedule has a dispatchable merge-sweep-remediate builtin', () => {
  const p = fileURLToPath(new URL('../dev-mesh/maintainer/.agent/schedule.json', import.meta.url));
  const job = JSON.parse(readFileSync(p, 'utf8')).jobs.find((j) => j.id === 'merge-sweep-remediate');
  assert.ok(job); assert.equal(job.kind, 'builtin'); assert.equal(job.builtin, 'merge-sweep-remediate');
  assert.equal(job.cadence.minutes, 30);
});
