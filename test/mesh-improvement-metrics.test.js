import { test } from 'node:test';
import assert from 'node:assert/strict';
import { METRICS, deltaPct, isRegression, median, computeStats } from '../src/mesh-improvement/metrics.js';
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

test('high-variance metrics use their own wider band, not the global one', () => {
  // latency_ms / cost_usd carry noiseBandPct:20 — a -19% wall-clock swing (issue #460)
  // and a -15.9% swing (issue #459) are within natural run-to-run variance, not fileable…
  assert.equal(isRegression('latency_ms', -19, 10), false);
  assert.equal(isRegression('latency_ms', -15.9, 10), false);
  assert.equal(isRegression('cost_usd', -19, 10), false);
  // …while swings past the per-metric band still flag.
  assert.equal(isRegression('latency_ms', -25, 10), true);
  assert.equal(isRegression('latency_ms', -35, 10), true);
  // A deterministic metric without an override still uses the caller's global band.
  assert.equal(isRegression('wasted_hops', -19, 10), true);
  assert.equal(isRegression('precision', -15.9, 10), true);
});

test('a wider global band is never narrowed by a per-metric override (Math.max)', () => {
  // When the caller's global band (25) exceeds the per-metric noiseBandPct (20),
  // the wider global band wins — a -22% swing stays within noise, not fileable.
  assert.equal(isRegression('latency_ms', -22, 25), false);
  assert.equal(isRegression('cost_usd', -22, 25), false);
  // The per-metric band still widens a narrower global band as before.
  assert.equal(isRegression('latency_ms', -19, 10), false);
  // Past the wider of the two bands it still flags.
  assert.equal(isRegression('latency_ms', -26, 25), true);
  // If the operator raises the global band to 30, a latency_ms swing of -25%
  // should be within band (30 wins over per-metric 20), not flag as a regression.
  assert.equal(isRegression('latency_ms', -25, 30), false);
  assert.equal(isRegression('cost_usd', -19, 30), false);
  // But a swing past the global band (AND the per-metric band) still flags.
  assert.equal(isRegression('latency_ms', -35, 30), true);
});

test('every metric with a noiseBandPct carries a positive number', () => {
  for (const [name, m] of Object.entries(METRICS)) {
    if ('noiseBandPct' in m) {
      assert.ok(typeof m.noiseBandPct === 'number' && m.noiseBandPct > 0, `${name} band`);
    }
  }
});

test('every registry metric has a direction; ids are validated', () => {
  for (const m of Object.values(METRICS)) {
    assert.ok(['higher_is_better', 'lower_is_better'].includes(m.direction));
  }
  assert.ok(MIR_ID_RE.test('perf:6x-confusable:routing-precision'));
  assert.ok(!MIR_ID_RE.test('perf:<script>'));
});

test('median: odd-length array returns middle element', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([0.9, 0.6, 0.8]), 0.8);
});

test('median: even-length array returns average of two middle elements', () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([0.6, 0.9]), 0.75);
});

test('median: single element returns that element', () => {
  assert.equal(median([0.42]), 0.42);
});

test('median: empty/null input returns null', () => {
  assert.equal(median([]), null);
  assert.equal(median(null), null);
  assert.equal(median(undefined), null);
});

test('computeStats: mean, sigma, cv for stable values', () => {
  const s = computeStats([1.0, 1.0, 1.0]);
  assert.equal(s.mean, 1.0);
  assert.equal(s.sigma, 0);
  assert.equal(s.cv, 0);
  assert.equal(s.n, 3);
});

test('computeStats: high-variance sequence has cv > 0', () => {
  // values: 1.0, 1.316, 0.684  (one outlier -31.6%)
  const s = computeStats([1.0, 1.316, 0.684]);
  assert.ok(s.cv > 0.1, `expected high cv but got ${s.cv}`);
});

test('computeStats: empty input returns null', () => {
  assert.equal(computeStats([]), null);
  assert.equal(computeStats(null), null);
});
