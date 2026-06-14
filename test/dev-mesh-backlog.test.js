// test/dev-mesh-backlog.test.js — pure backlog state machine (spec §5.4/§5.5).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STATES, deriveState, isClaimed, isReady, selectReady,
  canTransition, nextState, planClaim, summarize
} from '../src/dev-mesh/backlog.js';

const issue = (number, labels, assignees = []) => ({ number, labels, assignees });

test('deriveState: single label, and "ready" aliases to approved', () => {
  assert.equal(deriveState(issue(1, ['idea'])), STATES.IDEA);
  assert.equal(deriveState(issue(2, ['ready'])), STATES.APPROVED);
  assert.equal(deriveState(issue(3, [])), null);
  assert.equal(deriveState(issue(4, ['enhancement', 'p1'])), null); // no state labels
});

test('deriveState: furthest-along main-path label wins; rejected/blocked override', () => {
  assert.equal(deriveState(issue(1, ['approved', 'in-progress'])), STATES.IN_PROGRESS);
  assert.equal(deriveState(issue(2, ['in-progress', 'blocked'])), STATES.BLOCKED);
  assert.equal(deriveState(issue(3, ['approved', 'rejected'])), STATES.REJECTED);
});

test('isClaimed: in-progress OR assigned', () => {
  assert.equal(isClaimed(issue(1, ['in-progress'])), true);
  assert.equal(isClaimed(issue(2, ['approved'], ['bot'])), true);
  assert.equal(isClaimed(issue(3, ['approved'])), false);
});

test('isReady: approved AND unclaimed only', () => {
  assert.equal(isReady(issue(1, ['approved'])), true);
  assert.equal(isReady(issue(2, ['approved'], ['bot'])), false);   // already assigned
  assert.equal(isReady(issue(3, ['in-progress'])), false);
  assert.equal(isReady(issue(4, ['spec:in-review'])), false);
});

test('selectReady: filters claimable, sorted FIFO by number', () => {
  const issues = [
    issue(7, ['approved']),
    issue(3, ['approved'], ['bot']),   // claimed → excluded
    issue(5, ['ready']),               // alias
    issue(9, ['spec:in-review']),      // not ready
    issue(2, ['approved'])
  ];
  assert.deepEqual(selectReady(issues).map((i) => i.number), [2, 5, 7]);
});

test('transitions: legal vs illegal', () => {
  assert.equal(canTransition(STATES.APPROVED, STATES.IN_PROGRESS), true);
  assert.equal(canTransition(STATES.SPEC_IN_REVIEW, STATES.APPROVED), true);
  assert.equal(canTransition(STATES.PR_IN_REVIEW, STATES.IN_PROGRESS), true); // changes requested
  assert.equal(canTransition(STATES.IDEA, STATES.IN_PROGRESS), false);        // can't skip the gate
  assert.equal(canTransition(STATES.DONE, STATES.IN_PROGRESS), false);
  assert.equal(nextState(STATES.APPROVED, STATES.IN_PROGRESS), STATES.IN_PROGRESS);
  assert.throws(() => nextState(STATES.IDEA, STATES.DONE), /illegal backlog transition/);
});

test('planClaim: ready → atomic claim mutation; not-ready → null', () => {
  const plan = planClaim(issue(11, ['approved']), 'dev-mesh-bot');
  assert.deepEqual(plan, {
    number: 11,
    addLabels: [STATES.IN_PROGRESS],
    removeLabels: [STATES.APPROVED],
    addAssignee: 'dev-mesh-bot'
  });
  assert.equal(planClaim(issue(12, ['approved'], ['someone']), 'bot'), null); // already claimed
  assert.equal(planClaim(issue(13, ['idea']), 'bot'), null);
});

test('summarize: counts per state (mirror/dashboard); state is label-derived', () => {
  const counts = summarize([
    issue(1, ['idea']), issue(2, ['approved']), issue(3, ['approved'], ['bot']),
    issue(4, ['done']), issue(5, [])
  ]);
  // issue 3 is `approved` (assignee affects isClaimed, not deriveState) → approved: 2
  assert.deepEqual(counts, { idea: 1, approved: 2, done: 1, unknown: 1 });
});
