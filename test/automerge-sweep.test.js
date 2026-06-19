import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSweep } from '../src/automerge/sweep.js';

const ok = (n, over = {}) => ({ number: n, isDraft: false, isCrossRepository: false, mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', labels: [], ...over });

function ghStub(prs, { failMerge = [] } = {}) {
  const calls = [];
  const gh = async (args) => {
    calls.push(args);
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(prs);
    if (args[0] === 'pr' && args[1] === 'merge') {
      if (failMerge.includes(Number(args[2]))) throw new Error('not mergeable');
      return '';
    }
    return '';
  };
  return { gh, calls };
}

test('disabled → no list, no merge', async () => {
  const { gh, calls } = ghStub([ok(1)]);
  const r = await runSweep({ gh, repo: 'o/r', enabled: false });
  assert.equal(r.disabled, true);
  assert.equal(calls.length, 0);
});

test('merges only eligible PRs, with exact args', async () => {
  const prs = [ok(1), ok(2, { mergeStateStatus: 'DIRTY' }), ok(3, { reviewDecision: 'REVIEW_REQUIRED' }), ok(4)];
  const { gh, calls } = ghStub(prs);
  const r = await runSweep({ gh, repo: 'o/r', enabled: true });
  assert.deepEqual(r.merged, [1, 4]);
  assert.equal(r.ineligible, 2);
  const mergeCalls = calls.filter((a) => a[1] === 'merge');
  assert.deepEqual(mergeCalls[0], ['pr', 'merge', '1', '--repo', 'o/r', '--merge', '--delete-branch']);
  assert.equal(mergeCalls.length, 2);
});

test('one merge failure does not abort the rest (counted skipped)', async () => {
  const { gh } = ghStub([ok(1), ok(2)], { failMerge: [1] });
  const r = await runSweep({ gh, repo: 'o/r', enabled: true });
  assert.deepEqual(r.merged, [2]);
  assert.equal(r.skipped, 1);
});

test('dry-run merges nothing but reports the eligible set', async () => {
  const { gh, calls } = ghStub([ok(1), ok(2)]);
  const r = await runSweep({ gh, repo: 'o/r', enabled: true, dryRun: true });
  assert.deepEqual(r.merged, [1, 2]);
  assert.equal(calls.filter((a) => a[1] === 'merge').length, 0);
});

test('pr list failure → returns error, no throw', async () => {
  const gh = async () => { throw new Error('gh down'); };
  const r = await runSweep({ gh, repo: 'o/r', enabled: true });
  assert.equal(r.merged.length, 0);
  assert.ok(r.error);
});
