// test/report-aggregate.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, dayBoundsMs } from '../src/report/aggregate.js';

const DATE = '2026-06-18';
const inDay = '2026-06-18T09:00:00.000Z';
const nextDay = '2026-06-19T09:00:00.000Z';

test('dayBoundsMs returns the UTC calendar day [from, to)', () => {
  const { fromMs, toMs } = dayBoundsMs(DATE);
  assert.equal(new Date(fromMs).toISOString(), '2026-06-18T00:00:00.000Z');
  assert.equal(new Date(toMs).toISOString(), '2026-06-19T00:00:00.000Z');
});

test('aggregate buckets PRs/issues by in-window timestamps', () => {
  const r = aggregate({
    date: DATE,
    prs: [
      { number: 1, title: 'a', author: 'x', url: 'u1', createdAt: inDay, mergedAt: null, closedAt: null },
      { number: 2, title: 'b', author: 'y', url: 'u2', createdAt: '2026-06-10T00:00:00Z', mergedAt: inDay, closedAt: inDay },
      { number: 3, title: 'c', author: 'z', url: 'u3', createdAt: nextDay, mergedAt: null, closedAt: null },
    ],
    openPrs: [{ number: 1 }, { number: 9 }],
    issues: [
      { number: 5, title: 'i', labels: ['approved'], url: 'iu5', createdAt: inDay, closedAt: null },
      { number: 6, title: 'j', labels: [], url: 'iu6', createdAt: '2026-06-01T00:00:00Z', closedAt: inDay },
    ],
    openIssues: [{ number: 5, labels: ['approved'] }, { number: 7, labels: ['blocked', 'approved'] }],
    localRecords: [], ciRecords: [],
  });
  assert.deepEqual(r.prs.opened.map((p) => p.number), [1]);
  assert.deepEqual(r.prs.merged.map((p) => p.number), [2]);
  assert.equal(r.prs.openNow, 2);
  assert.deepEqual(r.issues.opened.map((i) => i.number), [5]);
  assert.deepEqual(r.issues.closed.map((i) => i.number), [6]);
  assert.deepEqual(r.issues.openByLabel, { approved: 2, blocked: 1 });
  assert.equal(r.issues.openNow, 2);   // parallel to prs.openNow — live open-issue total
});

test('aggregate sums local tokens by route and CI tokens by workflow', () => {
  const r = aggregate({
    date: DATE,
    prs: [], openPrs: [], issues: [], openIssues: [],
    localRecords: [
      { route: 'coder', finished_at: inDay, state: 'done', usage: { input_tokens: 100, output_tokens: 10, total_cost_usd: 0.5, num_turns: 3 } },
      { route: 'coder', finished_at: inDay, state: 'done', usage: { input_tokens: 50, output_tokens: 5, total_cost_usd: 0.25, num_turns: 1 } },
      { route: 'reviewer', finished_at: inDay, state: 'done', usage: { input_tokens: 20, output_tokens: 2, total_cost_usd: 0.1, num_turns: 1 } },
      { route: 'coder', finished_at: nextDay, state: 'done', usage: { input_tokens: 999, output_tokens: 999 } }, // out of window
    ],
    ciRecords: [
      { workflow: 'dev-mesh-review', runId: '1', ts: inDay, usage: { usage: { input_tokens: 1000, output_tokens: 100 }, num_turns: 9 } },
      { workflow: 'dev-mesh-triage', runId: '2', ts: inDay, usage: { usage: { input_tokens: 500, output_tokens: 50 }, num_turns: 4 } },
    ],
  });
  assert.equal(r.tokens.local.input, 170);
  assert.equal(r.tokens.local.byRoute.coder.input, 150);
  assert.equal(r.tokens.local.runs, 3);
  assert.equal(r.tokens.ci.input, 1500);
  assert.equal(r.tokens.ci.costUsd, 0);
  assert.equal(r.tokens.ci.byWorkflow['dev-mesh-review'].input, 1000);
  assert.equal(r.tokens.total.input, 1670);
});
