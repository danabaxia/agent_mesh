import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planPostMergeReconcile } from '../src/dev-society/post-merge-reconcile.js';

const iss = (number, labels) => ({ number, labels: labels.map((name) => ({ name })) });
const pr = (number, closes) => ({ number, closingIssuesReferences: closes.map((n) => ({ number: n })) });

test('closes an OPEN pr:in-review issue whose closing PR merged (the #183/#199 drift)', () => {
  const plan = planPostMergeReconcile(
    [iss(183, ['bug', 'approved', 'pr:in-review']), iss(999, ['bug', 'approved', 'pr:in-review'])],
    [pr(214, [183])],
  );
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0], { issue: 183, closingPr: 214, removeLabels: ['pr:in-review'] });
});

test('also clears in-progress; multiple in-flight labels removed', () => {
  const plan = planPostMergeReconcile([iss(5, ['bug', 'in-progress', 'pr:in-review'])], [pr(7, [5])]);
  assert.deepEqual(plan[0].removeLabels, ['pr:in-review', 'in-progress']);
});

test('does NOT touch an open issue with no in-flight label (e.g. human reopened)', () => {
  const plan = planPostMergeReconcile([iss(5, ['bug', 'approved'])], [pr(7, [5])]);
  assert.deepEqual(plan, []);
});

test('does NOT close an issue whose closing PR is not in the merged set', () => {
  // mergedPrs only contains PRs that ARE merged (caller filters via --state merged)
  const plan = planPostMergeReconcile([iss(5, ['pr:in-review'])], [pr(7, [99])]);
  assert.deepEqual(plan, []);
});

test('robust to empty / malformed input', () => {
  assert.deepEqual(planPostMergeReconcile([], []), []);
  assert.deepEqual(planPostMergeReconcile(undefined, undefined), []);
  assert.deepEqual(planPostMergeReconcile([iss(5, ['pr:in-review'])], [{ number: 7 }]), []); // PR w/ no refs
  assert.deepEqual(planPostMergeReconcile([{ labels: [{ name: 'pr:in-review' }] }], [pr(7, [5])]), []); // issue w/o number
});
