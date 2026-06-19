// test/issue-gate.test.js — pure logic for gating PR merge on the linked issue's state.
// Spec: docs/superpowers/specs/2026-06-19-issue-gates-pr-merge-design.md
import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldHoldForIssues, gateDecision, ISSUE_HOLD_LABEL, DEFAULT_BLOCK_LABELS } from '../src/automerge/issue-gate.js';

test('shouldHoldForIssues: holds when any linked issue carries a block label', () => {
  for (const l of DEFAULT_BLOCK_LABELS) {
    assert.equal(shouldHoldForIssues([[l]]), true, l);
  }
  assert.equal(shouldHoldForIssues([['bug', 'in-progress']]), false, 'normal labels do not hold');
  assert.equal(shouldHoldForIssues([['bug'], ['enhancement', 'rejected']]), true, 'any of several issues blocks');
});

test('shouldHoldForIssues: no linked issues / non-array → allow (false)', () => {
  assert.equal(shouldHoldForIssues([]), false);
  assert.equal(shouldHoldForIssues(undefined), false);
  assert.equal(shouldHoldForIssues(null), false);
  assert.equal(shouldHoldForIssues([[]]), false, 'an issue with no labels does not hold');
});

test('shouldHoldForIssues: custom blockLabels respected', () => {
  assert.equal(shouldHoldForIssues([['on-hold']], { blockLabels: ['on-hold'] }), true);
  assert.equal(shouldHoldForIssues([['blocked']], { blockLabels: ['on-hold'] }), false);
});

test('gateDecision: idempotent add/remove/none on the gate-owned label', () => {
  assert.equal(gateDecision([], true), 'add', 'should hold + label absent → add');
  assert.equal(gateDecision([ISSUE_HOLD_LABEL], true), 'none', 'should hold + already labelled → none');
  assert.equal(gateDecision([ISSUE_HOLD_LABEL], false), 'remove', 'should not hold + labelled → remove');
  assert.equal(gateDecision([], false), 'none', 'should not hold + absent → none');
  assert.equal(gateDecision(['do-not-merge'], false), 'none', 'never touches a foreign hold label');
  assert.equal(gateDecision(['do-not-merge'], true), 'add', 'adds its own label alongside a foreign one');
});
