import test from 'node:test';
import assert from 'node:assert/strict';
import { issuesLabel, tokenTotal } from '../src/dashboard/public/graph-view-model.js';
test('issuesLabel: openNow drives the "N open total" copy', () => {
  assert.equal(issuesLabel({ openNow: 3 }), '3 open total');
  assert.equal(issuesLabel({ openNow: 0 }), '0 open total');
  assert.equal(issuesLabel({}), '0 open total');
  assert.equal(issuesLabel(null), '0 open total');
});
test('tokenTotal: sums the series values, robust to missing data', () => {
  assert.equal(tokenTotal({ series: [{ value: 10 }, { value: 5 }] }), 15);
  assert.equal(tokenTotal({ series: [] }), 0);
  assert.equal(tokenTotal(null), 0);
});
