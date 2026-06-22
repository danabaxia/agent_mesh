import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchMergefix } from '../src/automerge/mergefix-dispatch.js';

function recordingGh(map) {
  const calls = [];
  return { calls, gh: async (args) => { calls.push(args); return map(args) ?? '[]'; } };
}

test('no DIRTY PRs → does NOT dispatch (no wasted Actions run)', async () => {
  const { calls, gh } = recordingGh(() => JSON.stringify([
    { number: 1, mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE', isDraft: false, isCrossRepository: false },
    { number: 2, mergeStateStatus: 'UNKNOWN', mergeable: 'UNKNOWN', isDraft: false, isCrossRepository: false },
  ]));
  const r = await dispatchMergefix({ gh, repo: 'o/r' });
  assert.deepEqual(r, { dispatched: false, dirtyCount: 0 });
  assert.ok(!calls.some((a) => a.includes('workflow')), 'must not dispatch when nothing is DIRTY');
});

test('open non-draft same-repo DIRTY PR → dispatches mergefix', async () => {
  const { calls, gh } = recordingGh(() => JSON.stringify([
    { number: 5, mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING', isDraft: false, isCrossRepository: false },
    { number: 6, mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE', isDraft: false, isCrossRepository: false },
  ]));
  const r = await dispatchMergefix({ gh, repo: 'o/r' });
  assert.equal(r.dispatched, true);
  assert.equal(r.dirtyCount, 1);
  const wf = calls.find((a) => a.includes('workflow'));
  assert.ok(wf && wf.includes('run') && wf.includes('dev-mesh-mergefix.yml') && wf.includes('o/r'));
});

test('draft and fork DIRTY PRs are excluded (mergefix only handles same-repo non-draft)', async () => {
  const { calls, gh } = recordingGh(() => JSON.stringify([
    { number: 7, mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING', isDraft: true, isCrossRepository: false },
    { number: 8, mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING', isDraft: false, isCrossRepository: true },
  ]));
  const r = await dispatchMergefix({ gh, repo: 'o/r' });
  assert.equal(r.dispatched, false);
  assert.equal(r.dirtyCount, 0);
  assert.ok(!calls.some((a) => a.includes('workflow')));
});

test('a failed list returns {dispatched:false} and never throws (loop-safe)', async () => {
  const gh = async () => { throw new Error('gh boom'); };
  const r = await dispatchMergefix({ gh, repo: 'o/r' });
  assert.equal(r.dispatched, false);
  assert.match(r.error, /boom/);
});
