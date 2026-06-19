import { test } from 'node:test';
import assert from 'node:assert/strict';
import { METRICS, deltaPct, isRegression } from '../src/mesh-improvement/metrics.js';
import { MIR_ID_RE } from '../src/config.js';

test('higher_is_better: drop is a negative deltaPct', () => {
  assert.equal(deltaPct('precision', 0.6, 0.9), -33.3);
  assert.equal(deltaPct('precision', 0.99, 0.9), 10); // improvement positive
});

test('lower_is_better: an increase is a negative deltaPct (regression)', () => {
  assert.equal(deltaPct('cost_usd', 0.04, 0.02), -100); // cost up = bad
  assert.equal(deltaPct('cost_usd', 0.01, 0.02), 50);   // cost down = good
});

test('null/zero baseline → null delta', () => {
  assert.equal(deltaPct('precision', 0.6, null), null);
  assert.equal(deltaPct('precision', 0.6, 0), null);
  assert.equal(deltaPct('precision', null, 0.9), null);
});

test('isRegression only past the band', () => {
  assert.equal(isRegression('precision', -33.3, 10), true);
  assert.equal(isRegression('precision', -5, 10), false);  // within band
  assert.equal(isRegression('precision', 20, 10), false);  // improvement
  assert.equal(isRegression('precision', null, 10), false);
});

test('every registry metric has a direction; ids are validated', () => {
  for (const m of Object.values(METRICS)) {
    assert.ok(['higher_is_better', 'lower_is_better'].includes(m.direction));
  }
  assert.ok(MIR_ID_RE.test('perf:6x-confusable:routing-precision'));
  assert.ok(!MIR_ID_RE.test('perf:<script>'));
});
