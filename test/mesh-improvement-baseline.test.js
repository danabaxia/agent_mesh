// test/mesh-improvement-baseline.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

// Rolling-window median tests
test('history is empty on first run', () => {
  const mir = applyBaseline(mk(0.889, 0.9), null, { at: AT, trendN: 10 });
  assert.deepEqual(mir.history['behavior:overall:pass-rate'], [0.889]);
  assert.deepEqual(mir.history['perf:6x-confusable:precision'], [0.9]);
});

test('cold start (< 3 prior values): falls back to single-previous-value', () => {
  const r1 = applyBaseline(mk(0.9, 0.9), null, { at: '2026-06-18T06:30:00.000Z', trendN: 10 });
  const r2 = applyBaseline(mk(0.889, 0.6), r1, { at: '2026-06-19T06:30:00.000Z', trendN: 10 });
  // Only 1 prior value — single-previous-value baseline
  const prec = r2.findings.find((f) => f.id === 'perf:6x-confusable:precision');
  assert.equal(prec.metric.baseline, 0.9);
  // history accumulates
  assert.deepEqual(r2.history['perf:6x-confusable:precision'], [0.9, 0.6]);
});

test('rolling-window median active at >= 3 prior values; single-outlier does not shift baseline much', () => {
  // Build 3 stable runs, then one outlier run.
  const AT1 = '2026-06-17T06:30:00.000Z';
  const AT2 = '2026-06-18T06:30:00.000Z';
  const AT3 = '2026-06-19T06:30:00.000Z';
  const AT4 = '2026-06-20T06:30:00.000Z';
  const r1 = applyBaseline(mk(0.9, 0.9), null, { at: AT1, trendN: 10 });
  const r2 = applyBaseline(mk(0.9, 0.9), r1,   { at: AT2, trendN: 10 });
  const r3 = applyBaseline(mk(0.9, 0.9), r2,   { at: AT3, trendN: 10 });
  // Now r3.history['perf:6x-confusable:precision'] = [0.9, 0.9, 0.9] (3 values)
  // Run 4: outlier drop to 0.6 (a -31.6%-style swing)
  const r4 = applyBaseline(mk(0.9, 0.6), r3, { at: AT4, trendN: 10 });
  const prec = r4.findings.find((f) => f.id === 'perf:6x-confusable:precision');
  // Median of [0.9, 0.9, 0.9] = 0.9; the outlier run sees its own drop compared to 0.9
  // but a FUTURE run after this outlier will see median of [0.9,0.9,0.9,0.6]=0.9 (even split: 0.9)
  assert.equal(prec.metric.baseline, 0.9); // median of 3× 0.9 = 0.9
  assert.equal(prec.metric.deltaPct, -33.3); // drop vs median still detected
  // history grows
  assert.deepEqual(r4.history['perf:6x-confusable:precision'], [0.9, 0.9, 0.9, 0.6]);
});

test('rolling-window median smooths sustained outlier: stable window baseline unchanged by single bad run', () => {
  // Scenario: 3 stable runs at 0.9, then 1 bad run at 0.6, then another run at 0.9
  // The 5th run should baseline against median([0.9,0.9,0.9,0.6]) = 0.9 (not 0.6)
  const dates = ['2026-06-16T00:00:00Z', '2026-06-17T00:00:00Z', '2026-06-18T00:00:00Z',
                 '2026-06-19T00:00:00Z', '2026-06-20T00:00:00Z'];
  let mir = null;
  for (let i = 0; i < 4; i++) {
    mir = applyBaseline(mk(0.9, i === 3 ? 0.6 : 0.9), mir, { at: dates[i], trendN: 10 });
  }
  // Run 5: value is back to 0.9
  const r5 = applyBaseline(mk(0.9, 0.9), mir, { at: dates[4], trendN: 10 });
  const prec = r5.findings.find((f) => f.id === 'perf:6x-confusable:precision');
  // median([0.9,0.9,0.9,0.6]) = (0.9+0.9)/2 = 0.9 for even-count mid two
  assert.equal(prec.metric.baseline, 0.9);
  assert.equal(prec.metric.deltaPct, 0); // back to baseline — no false positive
});

test('history is bounded by trendN', () => {
  let mir = null;
  const trendN = 3;
  const dates = Array.from({ length: 5 }, (_, i) => `2026-06-${15 + i}T00:00:00Z`);
  for (let i = 0; i < 5; i++) {
    mir = applyBaseline(mk(0.9, 0.9), mir, { at: dates[i], trendN });
  }
  assert.equal(mir.history['perf:6x-confusable:precision'].length, trendN);
});

// Spec-conformance guard (prevents re-introducing the §321 violation):
// If rolling-window code is present in baseline.js, §11 of the MIR spec must
// NOT list "rolling-window" as a v2-deferred feature.
test('spec conformance: rolling-window promoted — §11 no longer defers it', () => {
  const baselineSource = readFileSync(
    join(import.meta.dirname, '../src/mesh-improvement/baseline.js'), 'utf8');
  const mirSpec = readFileSync(
    join(import.meta.dirname, '../docs/superpowers/specs/2026-06-19-mesh-improvement-report-design.md'), 'utf8');
  const hasRollingWindowCode = /median\(/.test(baselineSource);
  if (hasRollingWindowCode) {
    // Find §11 section and assert rolling-window is not listed as deferred
    const section11 = mirSpec.match(/## 11\..*?(?=## \d+\.|$)/s)?.[0] ?? '';
    assert.ok(
      !section11.includes('rolling-window'),
      '§11 of the MIR spec still lists rolling-window as deferred, but the code is present. Update §11 to reflect promotion to v1.'
    );
  }
});
