import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAutomergePr, isAutoMergeable } from '../src/automerge/eligibility.js';

const clean = { number: 5, isDraft: false, isCrossRepository: false, mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', labels: [] };
const okGate = { held: new Set(), cleared: new Set(), ok: true };

test('clean PR with empty ok gate → would-merge', () => {
  assert.deepEqual(classifyAutomergePr(clean, { gate: okGate }), { state: 'would-merge', reason: null });
});
test('gate.held overrides → blocked/pending-issue-gate', () => {
  const r = classifyAutomergePr(clean, { gate: { held: new Set([5]), cleared: new Set(), ok: true } });
  assert.deepEqual(r, { state: 'blocked', reason: 'pending-issue-gate' });
});
test('gate.cleared ignores a stale blocked-by-issue label → would-merge', () => {
  const pr = { ...clean, labels: [{ name: 'blocked-by-issue' }] };
  const r = classifyAutomergePr(pr, { gate: { held: new Set(), cleared: new Set([5]), ok: true } });
  assert.deepEqual(r, { state: 'would-merge', reason: null });
});
test('draft / fork / not-clean / not-approved / hold-label each give the right reason', () => {
  assert.equal(classifyAutomergePr({ ...clean, isDraft: true }, { gate: okGate }).reason, 'draft');
  assert.equal(classifyAutomergePr({ ...clean, isCrossRepository: true }, { gate: okGate }).reason, 'fork');
  assert.match(classifyAutomergePr({ ...clean, mergeStateStatus: 'BLOCKED' }, { gate: okGate }).reason, /^not-clean:/);
  assert.match(classifyAutomergePr({ ...clean, reviewDecision: 'REVIEW_REQUIRED' }, { gate: okGate }).reason, /^not-approved:/);
  assert.equal(classifyAutomergePr({ ...clean, labels: [{ name: 'do-not-merge' }] }, { gate: okGate }).state, 'held');
});
test('fail-closed: gate.ok=false suppresses would-merge → blocked/gate-unknown', () => {
  assert.deepEqual(classifyAutomergePr(clean, { gate: { held: new Set(), cleared: new Set(), ok: false } }),
    { state: 'blocked', reason: 'gate-unknown' });
});
test('isAutoMergeable still agrees with would-merge under an empty ok gate', () => {
  assert.equal(isAutoMergeable(clean), true);
  assert.equal(isAutoMergeable({ ...clean, isDraft: true }), false);
});
