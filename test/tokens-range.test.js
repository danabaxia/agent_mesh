// test/tokens-range.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateRange, tokenTotals } from '../src/report/tokens-range.js';

const day = (date, locIn, ciIn, cost, routes, wfs) => ({
  date,
  tokens: {
    local: { input: locIn, output: locIn * 0.1, costUsd: cost, runs: 2, byRoute: routes },
    ci: { input: ciIn, output: ciIn * 0.1, costUsd: 0, runs: 5, byWorkflow: wfs },
    total: { input: locIn + ciIn, output: (locIn + ciIn) * 0.1, turns: 10 },
  },
});

test('tokenTotals flattens one model', () => {
  const f = tokenTotals(day('2026-06-18', 100, 1000, 0.5, {}, {}));
  assert.equal(f.local, 110);          // 100 + 10
  assert.equal(f.ci, 1100);            // 1000 + 100
  assert.equal(f.cost, 0.5);
  assert.equal(f.runs, 7);             // 2 local + 5 ci
});

test('tokenTotals on empty/garbage → zeros, no throw', () => {
  assert.deepEqual(tokenTotals(null), { input: 0, output: 0, local: 0, ci: 0, cost: 0, turns: 0, runs: 0 });
  assert.equal(tokenTotals({}).local, 0);
});

test('aggregateRange sums totals/cost, builds trend, merges consumers (agent + ci)', () => {
  const models = [
    day('2026-06-17', 100, 1000, 0.5, { coder: { input: 80, output: 8 } }, { 'dev-mesh-review': { input: 600, output: 60 } }),
    day('2026-06-18', 50, 500, 0.25, { coder: { input: 40, output: 4 }, reviewer: { input: 10, output: 1 } }, { 'dev-mesh-review': { input: 300, output: 30 } }),
  ];
  const r = aggregateRange(models);
  assert.equal(r.days, 2);
  assert.ok(Math.abs(r.cost - 0.75) < 1e-9);
  assert.equal(r.local, 165);          // (110)+(55)
  assert.equal(r.ci, 1650);            // (1100)+(550)
  assert.equal(r.total, r.input + r.output);
  assert.equal(r.trend.length, 2);
  assert.equal(r.trend[0].date, '2026-06-17');
  // top consumer = the CI workflow (660 + 330 = 990), then coder (88+44=132)
  assert.equal(r.byConsumer[0].name, 'dev-mesh-review');
  assert.equal(r.byConsumer[0].kind, 'ci');
  assert.equal(r.byConsumer[0].tokens, 990);
  const coder = r.byConsumer.find((c) => c.name === 'coder');
  assert.equal(coder.kind, 'agent');
  assert.equal(coder.tokens, 132);
});

test('aggregateRange on empty range → zeroed model', () => {
  const r = aggregateRange([]);
  assert.equal(r.days, 0);
  assert.equal(r.total, 0);
  assert.deepEqual(r.byConsumer, []);
  assert.deepEqual(r.trend, []);
});
