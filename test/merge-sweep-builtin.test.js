import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { runMergeSweep } from '../src/merge-sweep/run.js';

function recordingGh(map) {
  const calls = [];
  return { calls, gh: async (args) => { calls.push(args.join(' ')); return map(args) ?? '[]'; } };
}

test('runMergeSweep is read-only (no mutating commands) and writes one report', async () => {
  const { calls, gh } = recordingGh((args) => {
    const a = args.join(' ');
    if (a.includes('pr list') && a.includes('memory:promote')) return '[]';
    if (a.includes('pr list')) return JSON.stringify([{ number: 1, isDraft: false, isCrossRepository: false, mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', labels: [] }]);
    if (a.includes('pr view')) return JSON.stringify({ closingIssuesReferences: [] });
    return '[]';
  });
  let written = null;
  const r = await runMergeSweep({
    gh, repo: 'o/r', meshRoot: '/m/dev-mesh',
    readReport: () => ({}), writeReport: (path, rep) => { written = { path, rep }; }, now: new Date('2026-06-20T12:00:00Z'),
  });
  const forbidden = calls.filter((c) => /pr merge|pr edit|pr comment|git (push|commit|merge|checkout)/.test(c));
  assert.deepEqual(forbidden, [], 'must issue no mutating commands');
  assert.ok(written && written.path.endsWith(join('mesh', 'reports', 'merge-sweep.json')));   // OS-agnostic (Windows uses \)
  assert.equal(written.rep.mode, 'report');
  assert.equal(r.status, 'ok');
});

test('gate read failure → automerge fails closed (no would-merge)', async () => {
  const { gh } = recordingGh((args) => {
    const a = args.join(' ');
    if (a.includes('pr list') && a.includes('memory:promote')) return '[]';
    if (a.includes('pr list')) return JSON.stringify([{ number: 1, isDraft: false, isCrossRepository: false, mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', labels: [] }]);
    if (a.includes('pr view')) throw new Error('gate read fail');
    return '[]';
  });
  let written = null;
  await runMergeSweep({ gh, repo: 'o/r', meshRoot: '/m/dev-mesh', readReport: () => ({}), writeReport: (_p, rep) => { written = rep; }, now: new Date('2026-06-20T12:00:00Z') });
  const am = written.checkpoints.find((c) => c.name === 'automerge');
  assert.ok(!am.items.some((i) => i.state === 'would-merge'), 'no false would-merge when gate unknown');
});

test('memory:promote PRs are excluded from the automerge checkpoint (issue #274)', async () => {
  // memory:promote PRs are always UNSTABLE (GITHUB_TOKEN recursion guard prevents CI).
  // They must NOT appear in the automerge checkpoint — the memory-automerge checkpoint
  // owns them — otherwise they accumulate as blocked:not-clean:UNSTABLE and trigger
  // spurious needs-human escalations after 4+ sweeps.
  const memoryPr = { number: 99, isDraft: false, isCrossRepository: false, mergeStateStatus: 'UNSTABLE', reviewDecision: 'REVIEW_REQUIRED', labels: [{ name: 'memory:promote' }], title: 'memory: distill PR #98' };
  const { gh } = recordingGh((args) => {
    const a = args.join(' ');
    if (a.includes('pr list') && a.includes('memory:promote')) return JSON.stringify([memoryPr]);
    if (a.includes('pr list')) return JSON.stringify([memoryPr]);
    if (a.includes('pr view')) return JSON.stringify({ closingIssuesReferences: [] });
    return '[]';
  });
  let written = null;
  await runMergeSweep({ gh, repo: 'o/r', meshRoot: '/m/dev-mesh', readReport: () => ({}), writeReport: (_p, rep) => { written = rep; }, now: new Date('2026-06-20T12:00:00Z') });
  const am = written.checkpoints.find((c) => c.name === 'automerge');
  assert.ok(!am.items.some((i) => i.number === 99), 'memory:promote PR must not appear in automerge checkpoint');
});
