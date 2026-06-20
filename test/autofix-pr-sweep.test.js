// test/autofix-pr-sweep.test.js — hermetic tests for the autofix-PR sweep.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isAutofixIssue, abandonedAutofixPlan, BUG, PR_IN_REVIEW, BLOCKED } from '../src/dev-society/core.js';
import { runAutofixSweep } from '../src/dev-society/autofix-sweep.js';

const issue = (n, labels) => ({ number: n, title: `t${n}`, labels });

// ── pure helpers ────────────────────────────────────────────────────────────

test('isAutofixIssue: true only when both bug and pr:in-review are present', () => {
  assert.equal(isAutofixIssue(issue(1, [BUG, PR_IN_REVIEW])), true);
  assert.equal(isAutofixIssue(issue(2, [BUG])), false, 'missing pr:in-review');
  assert.equal(isAutofixIssue(issue(3, [PR_IN_REVIEW])), false, 'missing bug');
  assert.equal(isAutofixIssue(issue(4, [])), false, 'no labels');
});

test('isAutofixIssue: accepts label objects ({name}) as well as strings', () => {
  assert.equal(isAutofixIssue(issue(1, [{ name: BUG }, { name: PR_IN_REVIEW }])), true);
  assert.equal(isAutofixIssue(issue(2, [{ name: BUG }])), false);
});

test('abandonedAutofixPlan: adds blocked, removes pr:in-review', () => {
  const plan = abandonedAutofixPlan();
  assert.deepEqual(plan.add, [BLOCKED]);
  assert.deepEqual(plan.remove, [PR_IN_REVIEW]);
  assert.match(plan.comment, /closed without merging/);
  assert.match(plan.comment, /re-triage/);
});

// ── sweep ───────────────────────────────────────────────────────────────────

function fakeGh({ candidates = [], openPrs = {} }) {
  const calls = { edit: [], comment: [] };
  const gh = async (args) => {
    const joined = args.join(' ');
    if (joined.includes('issue list')) return JSON.stringify(candidates);
    if (joined.includes('pr list')) {
      const m = joined.match(/#(\d+)/);
      const n = m ? Number(m[1]) : null;
      return JSON.stringify(openPrs[n] ?? []);
    }
    if (joined.includes('issue edit')) { calls.edit.push(args); return ''; }
    if (joined.includes('issue comment')) { calls.comment.push(args); return ''; }
    return '';
  };
  return { gh, calls };
}

const run = (opts) => runAutofixSweep({ repo: 'o/r', enabled: true, ...opts });

test('disabled → no-op', async () => {
  const { gh } = fakeGh({ candidates: [issue(10, [BUG, PR_IN_REVIEW])] });
  const r = await runAutofixSweep({ gh, repo: 'o/r', enabled: false });
  assert.equal(r.disabled, true);
  assert.deepEqual(r.escalated, []);
});

test('escalates an abandoned issue (no open PR)', async () => {
  const { gh, calls } = fakeGh({
    candidates: [issue(10, [BUG, PR_IN_REVIEW])],
    openPrs: { 10: [] },
  });
  const r = await run({ gh });
  assert.deepEqual(r.escalated, [10]);
  assert.equal(calls.edit.length, 1, 'should edit labels');
  assert.equal(calls.comment.length, 1, 'should post comment');
  const editArgs = calls.edit[0];
  assert.ok(editArgs.includes('--add-label'), 'adds blocked');
  assert.ok(editArgs.includes('blocked'), 'adds blocked label');
  assert.ok(editArgs.includes('--remove-label'), 'removes pr:in-review');
  assert.ok(editArgs.includes('pr:in-review'), 'removes pr:in-review label');
});

test('skips issue that still has an open PR', async () => {
  const { gh, calls } = fakeGh({
    candidates: [issue(11, [BUG, PR_IN_REVIEW])],
    openPrs: { 11: [{ number: 42 }] },
  });
  const r = await run({ gh });
  assert.deepEqual(r.escalated, []);
  assert.equal(calls.edit.length, 0);
  assert.equal(calls.comment.length, 0);
});

test('dry-run: identifies candidate but makes no mutations', async () => {
  const { gh, calls } = fakeGh({
    candidates: [issue(12, [BUG, PR_IN_REVIEW])],
    openPrs: { 12: [] },
  });
  const r = await run({ gh, dryRun: true });
  assert.deepEqual(r.escalated, [12]);
  assert.equal(calls.edit.length, 0, 'dry-run: no edit');
  assert.equal(calls.comment.length, 0, 'dry-run: no comment');
});

test('skips issues missing bug or pr:in-review label', async () => {
  const { gh, calls } = fakeGh({
    candidates: [
      issue(20, [BUG]),          // missing pr:in-review
      issue(21, [PR_IN_REVIEW]), // missing bug
    ],
    openPrs: {},
  });
  const r = await run({ gh });
  assert.deepEqual(r.escalated, []);
  assert.equal(calls.edit.length, 0);
});

test('handles multiple candidates: escalates only abandoned ones', async () => {
  const { gh, calls } = fakeGh({
    candidates: [
      issue(30, [BUG, PR_IN_REVIEW]), // no open PR → escalate
      issue(31, [BUG, PR_IN_REVIEW]), // open PR → skip
      issue(32, [BUG, PR_IN_REVIEW]), // no open PR → escalate
    ],
    openPrs: { 30: [], 31: [{ number: 99 }], 32: [] },
  });
  const r = await run({ gh });
  assert.deepEqual(r.escalated.sort((a, b) => a - b), [30, 32]);
  assert.equal(calls.edit.length, 2);
  assert.equal(calls.comment.length, 2);
});

test('gh issue list error → returns error, no escalations', async () => {
  const gh = async () => { throw new Error('network'); };
  const r = await runAutofixSweep({ gh, repo: 'o/r', enabled: true });
  assert.deepEqual(r.escalated, []);
  assert.match(r.error, /network/);
});

test('per-item gh error is logged and skipped (other items still run)', async () => {
  const calls = { comment: [] };
  let first = true;
  const gh = async (args) => {
    const joined = args.join(' ');
    if (joined.includes('issue list')) {
      return JSON.stringify([issue(40, [BUG, PR_IN_REVIEW]), issue(41, [BUG, PR_IN_REVIEW])]);
    }
    if (joined.includes('pr list')) {
      const m = joined.match(/#(\d+)/);
      if (m && Number(m[1]) === 40 && first) { first = false; throw new Error('gh timeout'); }
      return JSON.stringify([]);
    }
    if (joined.includes('issue comment')) { calls.comment.push(args); return ''; }
    return '';
  };
  const r = await runAutofixSweep({ gh, repo: 'o/r', enabled: true });
  assert.equal(r.escalated.includes(40), false, 'errored item skipped');
  assert.equal(r.escalated.includes(41), true, 'other item still escalated');
});
