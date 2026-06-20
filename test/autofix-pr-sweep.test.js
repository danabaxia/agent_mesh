import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planAutofixPrSweep } from '../src/dev-society/autofix-pr-sweep.js';

const iss = (number, labels) => ({ number, labels: labels.map((name) => ({ name })) });
const pr = (number, closes) => ({ number, closingIssuesReferences: closes.map((n) => ({ number: n })) });

test('escalates a bug + pr:in-review issue whose linked PR was closed without merging', () => {
  const plan = planAutofixPrSweep(
    [iss(218, ['bug', 'pr:in-review']), iss(999, ['bug', 'pr:in-review'])],
    [pr(220, [218])],
  );
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0], { issue: 218, closedPr: 220, removeLabels: ['pr:in-review'], addLabels: ['blocked'] });
});

test('does NOT touch a non-bug pr:in-review issue (enhancement/idea still need human approval)', () => {
  const plan = planAutofixPrSweep(
    [iss(5, ['enhancement', 'pr:in-review']), iss(6, ['idea', 'pr:in-review'])],
    [pr(7, [5]), pr(8, [6])],
  );
  assert.deepEqual(plan, []);
});

test('does NOT touch a bug pr:in-review issue whose PR is not in the closed set', () => {
  // closedPrs only contains PRs that are closed-without-merge (caller filters via --state closed)
  const plan = planAutofixPrSweep([iss(5, ['bug', 'pr:in-review'])], [pr(7, [99])]);
  assert.deepEqual(plan, []);
});

test('does NOT touch a bug issue that is not pr:in-review', () => {
  const plan = planAutofixPrSweep([iss(5, ['bug', 'approved'])], [pr(7, [5])]);
  assert.deepEqual(plan, []);
});

test('does NOT re-escalate an issue already blocked', () => {
  const plan = planAutofixPrSweep([iss(5, ['bug', 'pr:in-review', 'blocked'])], [pr(7, [5])]);
  assert.deepEqual(plan, []);
});

test('does NOT escalate when the issue still has an OPEN PR (coder reopened/retried)', () => {
  const plan = planAutofixPrSweep(
    [iss(5, ['bug', 'pr:in-review'])],
    [pr(7, [5])],
    { openPrIssues: new Set([5]) },
  );
  assert.deepEqual(plan, []);
});

test('robust to empty / malformed input', () => {
  assert.deepEqual(planAutofixPrSweep([], []), []);
  assert.deepEqual(planAutofixPrSweep(undefined, undefined), []);
  assert.deepEqual(planAutofixPrSweep([iss(5, ['bug', 'pr:in-review'])], [{ number: 7 }]), []); // PR w/ no refs
  assert.deepEqual(planAutofixPrSweep([{ labels: [{ name: 'bug' }, { name: 'pr:in-review' }] }], [pr(7, [5])]), []); // issue w/o number
});
