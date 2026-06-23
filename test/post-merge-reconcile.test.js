import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planPostMergeReconcile } from '../src/dev-society/post-merge-reconcile.js';

const iss = (number, labels) => ({ number, labels: labels.map((name) => ({ name })) });
const pr = (number, closes) => ({ number, closingIssuesReferences: closes.map((n) => ({ number: n })) });

test('closes an OPEN pr:in-review issue whose closing PR merged (the #183/#199 drift)', () => {
  const plan = planPostMergeReconcile(
    [iss(183, ['bug', 'pr:in-review']), iss(999, ['bug', 'pr:in-review'])],
    [pr(214, [183])],
  );
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0], { issue: 183, closingPr: 214, removeLabels: ['pr:in-review'], addLabel: 'done' });
});

test('closes an `approved`-state orphan whose closing PR merged (the #248/#251 gap)', () => {
  // #248 sat at `approved` (never claimed in-progress); PR #251 merged with `Closes #248`
  // but GitHub's auto-close missed and the in-flight-only backstop skipped it.
  // The stale earlier-stage `idea` is also stripped (mutually-exclusive lifecycle, #430 P7).
  const plan = planPostMergeReconcile([iss(248, ['idea', 'approved'])], [pr(251, [248])]);
  assert.deepEqual(plan[0], { issue: 248, closingPr: 251, removeLabels: ['idea', 'approved'], addLabel: 'done' });
});

test('also clears in-progress; multiple stale state labels removed', () => {
  const plan = planPostMergeReconcile([iss(5, ['bug', 'in-progress', 'pr:in-review', 'approved'])], [pr(7, [5])]);
  assert.deepEqual(plan[0].removeLabels, ['approved', 'in-progress', 'pr:in-review']);
  assert.equal(plan[0].addLabel, 'done');
});

test('strips the WHOLE accumulated lifecycle group when collapsing to done (#430 P7 drift)', () => {
  // The label-state-drift symptom: an issue carrying a pre-approval stage label alongside its
  // in-flight label (e.g. `spec:in-review`+`pr:in-review`). Collapsing to `done` must leave
  // `done` as the ONLY lifecycle label — earlier stages get stripped, terminal/topic labels stay.
  const plan = planPostMergeReconcile(
    [iss(361, ['bug', 'discussing', 'spec:draft', 'spec:in-review', 'approved', 'in-progress', 'pr:in-review'])],
    [pr(400, [361])],
  );
  assert.deepEqual(plan[0].removeLabels, [
    'discussing', 'spec:draft', 'spec:in-review', 'approved', 'in-progress', 'pr:in-review',
  ]);
  assert.equal(plan[0].addLabel, 'done');
  // `bug` (a topic label) is NOT a lifecycle stage and survives.
  assert.ok(!plan[0].removeLabels.includes('bug'));
});

test('does NOT touch an open issue with no state label (e.g. human reopened)', () => {
  const plan = planPostMergeReconcile([iss(5, ['bug'])], [pr(7, [5])]);
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
