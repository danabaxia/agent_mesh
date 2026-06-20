import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAutoMergeable } from '../src/automerge/eligibility.js';

const ok = { number: 1, isDraft: false, isCrossRepository: false, mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', labels: [{ name: 'approved' }] };

test('CLEAN + APPROVED + same-repo + non-draft + no hold → mergeable', () => {
  assert.equal(isAutoMergeable(ok), true);
});
test('draft → not mergeable', () => assert.equal(isAutoMergeable({ ...ok, isDraft: true }), false));
test('fork (isCrossRepository) → not mergeable', () => assert.equal(isAutoMergeable({ ...ok, isCrossRepository: true }), false));
test('non-CLEAN merge states → not mergeable', () => {
  for (const s of ['BEHIND', 'BLOCKED', 'DIRTY', 'UNKNOWN', 'UNSTABLE', 'HAS_HOOKS', '']) {
    assert.equal(isAutoMergeable({ ...ok, mergeStateStatus: s }), false, s);
  }
});
test('non-APPROVED reviews → not mergeable', () => {
  for (const r of ['REVIEW_REQUIRED', 'CHANGES_REQUESTED', null, '']) {
    assert.equal(isAutoMergeable({ ...ok, reviewDecision: r }), false, String(r));
  }
});
test('any hold label → not mergeable', () => {
  for (const l of ['do-not-merge', 'hold', 'wip', 'blocked-by-issue']) {
    assert.equal(isAutoMergeable({ ...ok, labels: [{ name: 'approved' }, { name: l }] }), false, l);
  }
});
test('custom holdLabels respected', () => {
  assert.equal(isAutoMergeable({ ...ok, labels: [{ name: 'freeze' }] }, { holdLabels: ['freeze'] }), false);
});
test('fail-closed on garbage / missing fields', () => {
  assert.equal(isAutoMergeable(null), false);
  assert.equal(isAutoMergeable(undefined), false);
  assert.equal(isAutoMergeable({}), false);
  assert.equal(isAutoMergeable({ ...ok, labels: undefined }), true); // no labels = no hold
});

test('fail-closed: missing isDraft / isCrossRepository → not mergeable', () => {
  const noDraft = { number: 1, isCrossRepository: false, mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', labels: [] };
  assert.equal(isAutoMergeable(noDraft), false);            // isDraft missing
  const noFork = { number: 1, isDraft: false, mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', labels: [] };
  assert.equal(isAutoMergeable(noFork), false);             // isCrossRepository missing
});

test('hold label as a raw string is still caught', () => {
  const base = { number: 1, isDraft: false, isCrossRepository: false, mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED' };
  assert.equal(isAutoMergeable({ ...base, labels: ['hold'] }), false);
  assert.equal(isAutoMergeable({ ...base, labels: ['approved'] }), true);
});

test('malformed label entries do not throw and do not bypass', () => {
  const base = { number: 1, isDraft: false, isCrossRepository: false, mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED' };
  assert.equal(isAutoMergeable({ ...base, labels: [{}, null, { name: null }] }), true);  // none are holds, no throw
  assert.equal(isAutoMergeable({ ...base, labels: [{ name: 'hold' }, null] }), false);   // real hold still wins
});
