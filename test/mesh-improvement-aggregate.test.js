// test/mesh-improvement-aggregate.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate } from '../src/mesh-improvement/aggregate.js';

const AT = '2026-06-20T06:30:00.000Z';
const REF = { commit: 'abc1234', branch: 'main' };

const inputs = {
  tests: { summary: { files: 180, green: 179, red: 1 },
           results: [{ f: 'routing.test.js', status: 'FAIL', pass: '12', fail: '1', secs: '3' }] },
  behavior: { aggregate: { trials: 9, passed: 8, passRate: 0.889 }, scenarios: [] },
  adversarial: { aggregate: { trials: 7, passed: 6, passRate: 0.857 },
                 scenarios: [{ name: 'I3-out-of-root-write', passRate: 0, trials: [
                   { pass: false, probes: [{ name: 'noExternalWrite', pass: false, detail: 'wrote /tmp/x' }] }] }] },
  perf: { scenarios: [{ name: '6x-confusable', cell: { peers: 6, overlap: 'confusable' },
           summary: { precision: { p50: 0.6, mean: 0.6 }, quality_per_1k_tokens: { p50: 333 },
                      wasted_hops: { p50: 1 }, cost_usd: { p50: 0.03 }, latency_ms: { p50: 3200 } } }] },
  runLogs: [{ id: 'delegate-1', route: 'ask', status: 'timeout', summary: 'killed at 600s',
              log_path: '.agent-mesh/logs/delegate-2026-06-20.jsonl' }],
};

test('hard findings: red test, failed invariant, error/timeout run-log', () => {
  const mir = aggregate(inputs, { at: AT, ref: REF });
  const hard = mir.findings.filter((f) => f.tier === 'hard').map((f) => f.id);
  assert.ok(hard.includes('test:routing-test-js:red'));
  assert.ok(hard.includes('adversarial:i3-out-of-root-write:failed'));
  assert.ok(hard.includes('runlog:ask:timeout'));
});

test('soft candidate findings carry value + direction, no delta yet', () => {
  const mir = aggregate(inputs, { at: AT, ref: REF });
  const prec = mir.findings.find((f) => f.id === 'perf:6x-confusable:precision');
  assert.equal(prec.tier, 'soft');
  assert.equal(prec.metric.value, 0.6);
  assert.equal(prec.metric.direction, 'higher_is_better');
  assert.equal(prec.metric.deltaPct, null);
  assert.equal(prec.fileable, null);
  assert.deepEqual(prec.weakestCell, { peers: 6, overlap: 'confusable' });
  const beh = mir.findings.find((f) => f.id === 'behavior:overall:passRate');
  assert.equal(beh.metric.value, 0.889);
});

test('summary + schema are populated; missing inputs tolerated', () => {
  const mir = aggregate(inputs, { at: AT, ref: REF });
  assert.equal(mir.schema, 'mesh-improvement-report/v1');
  assert.equal(mir.summary.tests.red, 1);
  assert.equal(mir.summary.behavior.passRate, 0.889);
  assert.equal(mir.summary.adversarial.invariantsPassed, '6/7');
  const empty = aggregate({ tests: null, behavior: null, adversarial: null, perf: null, runLogs: [] }, { at: AT, ref: REF });
  assert.equal(empty.findings.length, 0);
  assert.equal(empty.summary.behavior.passRate, null);
});
