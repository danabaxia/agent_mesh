import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markJobDue, describeJob } from '../src/schedule/run-now.js';

const NOW = new Date('2026-06-19T12:00:00Z');

test('markJobDue sets nextRunAt=now + running:false, preserves other state, clones (no mutation)', () => {
  const state = { p: { lastStatus: 'ok', nextRunAt: '2030-01-01T00:00:00Z', running: true }, q: { lastStatus: 'fail' } };
  const next = markJobDue(state, 'p', NOW);
  assert.equal(next.p.nextRunAt, '2026-06-19T12:00:00.000Z');
  assert.equal(next.p.running, false);
  assert.equal(next.p.lastStatus, 'ok');                 // preserved
  assert.deepEqual(next.q, { lastStatus: 'fail' });      // other jobs untouched
  assert.notEqual(next, state);                          // new object
  assert.equal(state.p.running, true);                   // original not mutated
});

test('markJobDue creates the entry if absent / state missing or non-object', () => {
  assert.deepEqual(markJobDue({}, 'p', NOW).p, { nextRunAt: '2026-06-19T12:00:00.000Z', running: false });
  assert.deepEqual(markJobDue(null, 'p', NOW).p, { nextRunAt: '2026-06-19T12:00:00.000Z', running: false });
});

test('describeJob: description → prompt first line → empty; trimmed + capped', () => {
  assert.equal(describeJob({ description: '  Poll GH Actions  ' }), 'Poll GH Actions');
  assert.equal(describeJob({ prompt: '\n\nReview the open PRs\nand comment' }), 'Review the open PRs');
  assert.equal(describeJob({ description: '', prompt: 'fallback line' }), 'fallback line');
  assert.equal(describeJob({}), '');
  assert.equal(describeJob(null), '');
  assert.equal(describeJob({ description: 'x'.repeat(500) }).length, 200);
});
