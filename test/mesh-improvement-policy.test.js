// test/mesh-improvement-policy.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gate } from '../src/mesh-improvement/policy.js';

const finding = (over) => ({
  id: 'x', tier: 'soft', cluster: 'c', severity: null,
  metric: { name: 'precision', value: 0.6, baseline: 0.9, direction: 'higher_is_better', deltaPct: -33.3 },
  weakestCell: null, evidence: {}, fileable: null, ...over,
});

test('hard findings are always fileable as errors', () => {
  const mir = gate({ findings: [finding({ tier: 'hard',
    metric: { name: 'hard_signal', value: 1, baseline: null, direction: null, deltaPct: null } })] },
    { noiseBandPct: 10 });
  assert.equal(mir.findings[0].fileable, true);
  assert.equal(mir.findings[0].severity, 'error');
});

test('soft regression past the band is fileable as a warning', () => {
  const mir = gate({ findings: [finding()] }, { noiseBandPct: 10 });
  assert.equal(mir.findings[0].fileable, true);
  assert.equal(mir.findings[0].severity, 'warning');
});

test('soft within band is not fileable', () => {
  const mir = gate({ findings: [finding({ metric: { name: 'precision', value: 0.88, baseline: 0.9,
    direction: 'higher_is_better', deltaPct: -2.2 } })] }, { noiseBandPct: 10 });
  assert.equal(mir.findings[0].fileable, false);
});

test('first/zero baseline soft never fileable', () => {
  const mir = gate({ findings: [finding({ metric: { name: 'precision', value: 0.6, baseline: null,
    direction: 'higher_is_better', deltaPct: null } })] }, { noiseBandPct: 10 });
  assert.equal(mir.findings[0].fileable, false);
});
