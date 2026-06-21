import test from 'node:test';
import assert from 'node:assert/strict';
import { isStale, backoffDelays } from '../src/dashboard/public/freshness.js';
test('isStale: fresh within threshold, stale at/after it', () => {
  assert.equal(isStale(1000, 1500, 1000), false);
  assert.equal(isStale(1000, 2000, 1000), true);
  assert.equal(isStale(1000, 5000, 1000), true);
});
test('isStale: null lastUpdateAt is always stale', () => { assert.equal(isStale(null, 5000, 1000), true); });
test('backoffDelays: capped exponential sequence', () => { assert.deepEqual(backoffDelays(1000, 8000, 5), [1000, 2000, 4000, 8000, 8000]); });
