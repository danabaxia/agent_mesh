import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchReviewRespond } from '../src/automerge/review-respond-dispatch.js';

function recordingGh(map) {
  const calls = [];
  return { calls, gh: async (args) => { calls.push(args); return map(args) ?? '[]'; } };
}

test('no CHANGES_REQUESTED PRs → does NOT dispatch (no wasted Actions run)', async () => {
  const { calls, gh } = recordingGh(() => JSON.stringify([
    { number: 1, reviewDecision: 'APPROVED', isDraft: false },
    { number: 2, reviewDecision: 'REVIEW_REQUIRED', isDraft: false },
  ]));
  const r = await dispatchReviewRespond({ gh, repo: 'o/r' });
  assert.deepEqual(r, { dispatched: false, pendingCount: 0 });
  assert.ok(!calls.some((a) => a.includes('workflow')), 'must not dispatch when nothing is CHANGES_REQUESTED');
});

test('open non-draft CHANGES_REQUESTED PRs → dispatches the responder workflow', async () => {
  const { calls, gh } = recordingGh(() => JSON.stringify([
    { number: 1, reviewDecision: 'CHANGES_REQUESTED', isDraft: false },
    { number: 2, reviewDecision: 'CHANGES_REQUESTED', isDraft: false },
    { number: 3, reviewDecision: 'APPROVED', isDraft: false },
  ]));
  const r = await dispatchReviewRespond({ gh, repo: 'o/r' });
  assert.equal(r.dispatched, true);
  assert.equal(r.pendingCount, 2);
  const wf = calls.find((a) => a.includes('workflow'));
  assert.ok(wf && wf.includes('run') && wf.includes('dev-mesh-review-respond.yml') && wf.includes('o/r'));
});

test('draft CHANGES_REQUESTED PRs are excluded (not ready for a responder)', async () => {
  const { calls, gh } = recordingGh(() => JSON.stringify([
    { number: 1, reviewDecision: 'CHANGES_REQUESTED', isDraft: true },
  ]));
  const r = await dispatchReviewRespond({ gh, repo: 'o/r' });
  assert.equal(r.dispatched, false);
  assert.equal(r.pendingCount, 0);
  assert.ok(!calls.some((a) => a.includes('workflow')));
});

test('a failed list returns {dispatched:false} and never throws (loop-safe)', async () => {
  const gh = async () => { throw new Error('gh boom'); };
  const r = await dispatchReviewRespond({ gh, repo: 'o/r' });
  assert.equal(r.dispatched, false);
  assert.match(r.error, /boom/);
});
