import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMergeSweepReport, mergeSweepReportPath } from '../src/merge-sweep/report.js';
import { join } from 'node:path';

const NOW = new Date('2026-06-20T12:00:00.000Z');
const cp = (name, status, items = []) => ({ name, status, items });

test('flagged when an item is non-resolved; clean when none; error when checkpoint errored', () => {
  const r = buildMergeSweepReport([
    cp('issue-gate', 'flagged', [{ ref: 'PR#1', number: 1, state: 'would-clear', detail: '' }]),
    cp('automerge', 'clean', []),
    { name: 'memory-automerge', status: 'error', error: 'boom', items: [] },
  ], {}, NOW);
  assert.equal(r.summary.flagged, 1); assert.equal(r.summary.ok, 1); assert.equal(r.summary.errors, 1);
  assert.equal(r.checkpoints[0].items[0].ageRuns, 1);
  assert.equal(r.checkpoints[0].items[0].firstSeen, NOW.toISOString());
});

test('age increments when same ref+state persists; resets when state changes', () => {
  const prev = { checkpoints: [{ name: 'automerge', items: [
    { ref: 'PR#9', number: 9, state: 'held', firstSeen: '2026-06-20T11:00:00.000Z', ageRuns: 2 }] }] };
  const inc = buildMergeSweepReport([cp('automerge', 'flagged', [{ ref: 'PR#9', number: 9, state: 'held', detail: '' }])], prev, NOW);
  assert.equal(inc.checkpoints[0].items[0].ageRuns, 3);
  assert.equal(inc.checkpoints[0].items[0].firstSeen, '2026-06-20T11:00:00.000Z');
  const reset = buildMergeSweepReport([cp('automerge', 'flagged', [{ ref: 'PR#9', number: 9, state: 'blocked', detail: '' }])], prev, NOW);
  assert.equal(reset.checkpoints[0].items[0].ageRuns, 1);
});

test('resolved: a ref flagged in prev but absent now is emitted once as resolved, then dropped', () => {
  const prev = { checkpoints: [{ name: 'automerge', items: [{ ref: 'PR#9', number: 9, state: 'held', firstSeen: NOW.toISOString(), ageRuns: 1 }] }] };
  const r1 = buildMergeSweepReport([cp('automerge', 'clean', [])], prev, NOW);
  const it = r1.checkpoints[0].items.find((i) => i.ref === 'PR#9');
  assert.equal(it.state, 'resolved');
  const r2 = buildMergeSweepReport([cp('automerge', 'clean', [])], r1, NOW);
  assert.ok(!r2.checkpoints[0].items.some((i) => i.ref === 'PR#9'));
});

test('mergeSweepReportPath is deterministic under a meshRoot', () => {
  assert.equal(mergeSweepReportPath('/m/dev-mesh'), join('/m/dev-mesh', 'mesh', 'reports', 'merge-sweep.json'));
});
