// test/mesh-improvement-baseline.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyBaseline } from '../src/mesh-improvement/baseline.js';

const AT = '2026-06-20T06:30:00.000Z';
const mk = (passRate, precision, extraFindings = []) => ({
  schema: 'mesh-improvement-report/v1', at: AT, ref: { commit: 'cur', branch: 'main' },
  summary: { tests: { green: 179, red: 1, delta: null }, behavior: { passRate, delta: null },
             adversarial: { invariantsPassed: '7/7', delta: null },
             perf: { quality_per_1k_tokens_p50: 333, wasted_hops_p50: 1, delta: null } },
  findings: [
    { id: 'behavior:overall:pass-rate', tier: 'soft', cluster: 'behavior-regression', severity: null,
      metric: { name: 'passRate', value: passRate, baseline: null, direction: 'higher_is_better', deltaPct: null },
      weakestCell: null, evidence: {}, fileable: null },
    { id: 'perf:6x-confusable:precision', tier: 'soft', cluster: 'perf-regression', severity: null,
      metric: { name: 'precision', value: precision, baseline: null, direction: 'higher_is_better', deltaPct: null },
      weakestCell: { peers: 6, overlap: 'confusable' }, evidence: {}, fileable: null },
    ...extraFindings,
  ],
});

test('first run: null baseline, null deltas, fresh ledger', () => {
  const mir = applyBaseline(mk(0.889, 0.9), null, { at: AT, trendN: 10 });
  assert.equal(mir.baseline, null);
  assert.equal(mir.findings[0].metric.deltaPct, null);
  assert.equal(mir.ledger['perf:6x-confusable:precision'].occurrences, 1);
  assert.equal(mir.ledger['perf:6x-confusable:precision'].cleanRuns, 0);
  assert.deepEqual(mir.trend.passRate, [0.889]);
});

test('second run computes signed deltas vs previous finding values', () => {
  const prev = applyBaseline(mk(0.9, 0.9), null, { at: '2026-06-19T06:30:00.000Z', trendN: 10 });
  const cur = applyBaseline(mk(0.889, 0.6), prev, { at: AT, trendN: 10 });
  const prec = cur.findings.find((f) => f.id === 'perf:6x-confusable:precision');
  assert.equal(prec.metric.baseline, 0.9);
  assert.equal(prec.metric.deltaPct, -33.3);
  assert.equal(cur.baseline.commit, 'cur');
  assert.deepEqual(cur.trend.passRate, [0.9, 0.889]);
});

test('absent id carries forward with cleanRuns++ until GC; present id resets cleanRuns', () => {
  const stale = { id: 'perf:3x-disjoint:cost_usd', tier: 'soft', cluster: 'perf-regression', severity: null,
    metric: { name: 'cost_usd', value: 0.02, baseline: null, direction: 'lower_is_better', deltaPct: null },
    weakestCell: null, evidence: {}, fileable: null };
  const prev = applyBaseline(mk(0.9, 0.9, [stale]), null, { at: '2026-06-19T06:30:00.000Z', trendN: 10 });
  prev.ledger['perf:3x-disjoint:cost_usd'].issueNumber = 99; // simulate it was filed
  const cur = applyBaseline(mk(0.889, 0.9), prev, { at: AT, trendN: 10 }); // stale id absent now
  assert.equal(cur.ledger['perf:3x-disjoint:cost_usd'].cleanRuns, 1);
  assert.equal(cur.ledger['perf:3x-disjoint:cost_usd'].issueNumber, 99); // retained until closed
  assert.equal(cur.ledger['perf:6x-confusable:precision'].cleanRuns, 0);
});
