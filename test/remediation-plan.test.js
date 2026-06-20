import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRemediation, markerFor, itemKey, ACTIONABLE } from '../src/merge-sweep/remediation.js';

const CFG = { escalateAfter: 4, hysteresisK: 3, capPerRun: 5, backoffBaseMs: 1_800_000 };
const NOW = new Date('2026-06-20T12:00:00.000Z');
const rep = (items, cp = 'automerge') => ({ available: true, checkpoints: [{ name: cp, status: 'flagged', items }] });
const blocked = (n, age, detail = 'not-clean:DIRTY') => ({ ref: `PR#${n}`, number: n, state: 'blocked', detail, ageRuns: age });

test('ACTIONABLE: only automerge not-clean:* and memory needs-human', () => {
  assert.equal(ACTIONABLE('automerge', { state: 'blocked', detail: 'not-clean:DIRTY' }), true);
  assert.equal(ACTIONABLE('automerge', { state: 'blocked', detail: 'pending-issue-gate' }), false);
  assert.equal(ACTIONABLE('automerge', { state: 'would-merge' }), false);
  assert.equal(ACTIONABLE('automerge', { state: 'held', detail: 'do-not-merge' }), false);
  assert.equal(ACTIONABLE('memory-automerge', { state: 'needs-human' }), true);
  assert.equal(ACTIONABLE('memory-automerge', { state: 'merge-candidate' }), false);
});

test('open-gate: ageRuns < N → watching, no file; ≥ N → propose file', () => {
  const young = planRemediation({ report: rep([blocked(1, 3)]), prev: {}, ownIssues: {}, triagePrNums: new Set(), now: NOW, cfg: CFG });
  assert.deepEqual(young.file, []);
  assert.equal(young.nextState['automerge:PR#1'].state, 'watching');
  const old = planRemediation({ report: rep([blocked(1, 4)]), prev: {}, ownIssues: {}, triagePrNums: new Set(), now: NOW, cfg: CFG });
  assert.equal(old.file.length, 1);
  assert.equal(old.file[0].key, 'automerge:PR#1');
  assert.equal(old.nextState['automerge:PR#1'].state, 'escalated');
});

test('dedup: existing OPEN own issue → no file (escalated); open needs-triage for the PR → no file', () => {
  const own = planRemediation({ report: rep([blocked(1, 9)]), prev: {}, ownIssues: { 'automerge:PR#1': { issueNumber: 50, open: true } }, triagePrNums: new Set(), now: NOW, cfg: CFG });
  assert.deepEqual(own.file, []);
  assert.equal(own.nextState['automerge:PR#1'].state, 'escalated');
  assert.equal(own.nextState['automerge:PR#1'].issueNumber, 50);
  const tri = planRemediation({ report: rep([blocked(1, 9)]), prev: {}, ownIssues: {}, triagePrNums: new Set([1]), now: NOW, cfg: CFG });
  assert.deepEqual(tri.file, []);
  assert.equal(tri.nextState['automerge:PR#1'].state, 'escalated');
});

test('cap: more than capPerRun eligible → only capPerRun proposed', () => {
  const items = Array.from({ length: 7 }, (_, i) => blocked(i + 1, 9));
  const r = planRemediation({ report: rep(items), prev: {}, ownIssues: {}, triagePrNums: new Set(), now: NOW, cfg: { ...CFG, capPerRun: 5 } });
  assert.equal(r.file.length, 5);
});

test('human-ack: our issue CLOSED while still stuck (we had not self-closed) → acked, never re-file', () => {
  const prev = { 'automerge:PR#1': { state: 'escalated', issueNumber: 50 } };
  const r = planRemediation({ report: rep([blocked(1, 9)]), prev, ownIssues: { 'automerge:PR#1': { issueNumber: 50, open: false } }, triagePrNums: new Set(), now: NOW, cfg: CFG });
  assert.deepEqual(r.file, []);
  assert.equal(r.nextState['automerge:PR#1'].state, 'acked');
});

test('delayed close: resolved 1 sweep → cooldown (issue stays open); after hysteresisK → propose close → done', () => {
  let prev = { 'automerge:PR#1': { state: 'escalated', issueNumber: 50, healthyStreak: 0 } };
  let r = planRemediation({ report: rep([]), prev, ownIssues: { 'automerge:PR#1': { issueNumber: 50, open: true } }, triagePrNums: new Set(), now: NOW, cfg: CFG });
  assert.deepEqual(r.close, []);
  assert.equal(r.nextState['automerge:PR#1'].state, 'cooldown');
  assert.equal(r.nextState['automerge:PR#1'].healthyStreak, 1);
  prev = r.nextState;
  r = planRemediation({ report: rep([]), prev, ownIssues: { 'automerge:PR#1': { issueNumber: 50, open: true } }, triagePrNums: new Set(), now: NOW, cfg: CFG });
  assert.equal(r.nextState['automerge:PR#1'].healthyStreak, 2);
  assert.deepEqual(r.close, []);
  prev = r.nextState;
  r = planRemediation({ report: rep([]), prev, ownIssues: { 'automerge:PR#1': { issueNumber: 50, open: true } }, triagePrNums: new Set(), now: NOW, cfg: CFG });
  assert.deepEqual(r.close, [{ key: 'automerge:PR#1', issueNumber: 50 }]);
  assert.equal(r.nextState['automerge:PR#1'].state, 'done');
});

test('cooldown item re-stuck → escalated, SAME open issue, no new file', () => {
  const prev = { 'automerge:PR#1': { state: 'cooldown', issueNumber: 50, healthyStreak: 1 } };
  const r = planRemediation({ report: rep([blocked(1, 9)]), prev, ownIssues: { 'automerge:PR#1': { issueNumber: 50, open: true } }, triagePrNums: new Set(), now: NOW, cfg: CFG });
  assert.deepEqual(r.file, []);
  assert.equal(r.nextState['automerge:PR#1'].state, 'escalated');
});

test('done → re-stuck applies backoff (nextEligibleAt), no immediate file', () => {
  const prev = { 'automerge:PR#1': { state: 'done', issueNumber: 50, reopenCount: 0 } };
  const r = planRemediation({ report: rep([blocked(1, 9)]), prev, ownIssues: {}, triagePrNums: new Set(), now: NOW, cfg: CFG });
  assert.deepEqual(r.file, []);
  assert.equal(r.nextState['automerge:PR#1'].state, 'cooldown');
  assert.equal(r.nextState['automerge:PR#1'].reopenCount, 1);
  assert.ok(Date.parse(r.nextState['automerge:PR#1'].nextEligibleAt) > NOW.getTime());
});

test('exempt issue → never auto-closed', () => {
  const prev = { 'automerge:PR#1': { state: 'cooldown', issueNumber: 50, healthyStreak: 2 } };
  const r = planRemediation({ report: rep([]), prev, ownIssues: { 'automerge:PR#1': { issueNumber: 50, open: true, exempt: true } }, triagePrNums: new Set(), now: NOW, cfg: CFG });
  assert.deepEqual(r.close, []);
});

test('markerFor / itemKey', () => {
  assert.equal(itemKey('automerge', 'PR#7'), 'automerge:PR#7');
  assert.equal(markerFor('automerge:PR#7'), '<!-- needs-human:automerge:PR#7 -->');
});
