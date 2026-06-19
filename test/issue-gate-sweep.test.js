// test/issue-gate-sweep.test.js — the impure-but-injected issue-gate sweep: stamps/clears
// the blocked-by-issue label on PRs based on their linked issues' state. gh is injected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runIssueGate } from '../src/automerge/issue-gate-sweep.js';

// Build an injected gh() that answers the three call shapes the sweep makes, and records
// every label edit it performs.
function fakeGh({ prs, refs = {}, issues = {} }) {
  const edits = [];
  const gh = async (args) => {
    const a = args.join(' ');
    if (a.includes('pr list')) return JSON.stringify(prs);
    if (a.includes('pr view')) {
      const n = args[args.indexOf('view') + 1];
      return JSON.stringify({ closingIssuesReferences: (refs[n] || []).map((number) => ({ number })) });
    }
    if (a.includes('issue view')) {
      const n = args[args.indexOf('view') + 1];
      return JSON.stringify({ labels: (issues[n] || []).map((name) => ({ name })) });
    }
    if (a.includes('pr edit')) {
      const n = args[args.indexOf('edit') + 1];
      const add = args.includes('--add-label') ? args[args.indexOf('--add-label') + 1] : null;
      const rm = args.includes('--remove-label') ? args[args.indexOf('--remove-label') + 1] : null;
      edits.push({ pr: n, add, rm });
      return '';
    }
    return '';
  };
  return { gh, edits };
}

test('disabled (enabled !== true) → no-op', async () => {
  const { gh, edits } = fakeGh({ prs: [{ number: 1, labels: [] }] });
  const r = await runIssueGate({ gh, repo: 'o/r', enabled: false });
  assert.equal(r.disabled, true);
  assert.equal(edits.length, 0);
});

test('linked issue blocked → adds blocked-by-issue', async () => {
  const { gh, edits } = fakeGh({
    prs: [{ number: 10, labels: [] }],
    refs: { 10: [42] },
    issues: { 42: ['bug', 'blocked'] },
  });
  const r = await runIssueGate({ gh, repo: 'o/r', enabled: true });
  assert.deepEqual(r.held, [10]);
  assert.deepEqual(edits, [{ pr: '10', add: 'blocked-by-issue', rm: null }]);
});

test('issue no longer blocked but PR still labelled → removes', async () => {
  const { gh, edits } = fakeGh({
    prs: [{ number: 11, labels: [{ name: 'blocked-by-issue' }] }],
    refs: { 11: [43] },
    issues: { 43: ['enhancement', 'in-progress'] },
  });
  const r = await runIssueGate({ gh, repo: 'o/r', enabled: true });
  assert.deepEqual(r.cleared, [11]);
  assert.deepEqual(edits, [{ pr: '11', add: null, rm: 'blocked-by-issue' }]);
});

test('no linked issue → no action', async () => {
  const { gh, edits } = fakeGh({ prs: [{ number: 12, labels: [] }], refs: { 12: [] } });
  const r = await runIssueGate({ gh, repo: 'o/r', enabled: true });
  assert.deepEqual(r.held, []);
  assert.deepEqual(r.cleared, []);
  assert.equal(edits.length, 0);
});

test('dryRun → decides but performs no edits', async () => {
  const { gh, edits } = fakeGh({
    prs: [{ number: 13, labels: [] }],
    refs: { 13: [44] }, issues: { 44: ['rejected'] },
  });
  const r = await runIssueGate({ gh, repo: 'o/r', enabled: true, dryRun: true });
  assert.deepEqual(r.held, [13]);
  assert.equal(edits.length, 0, 'dryRun makes no gh pr edit calls');
});

test('a foreign hold label is left untouched (only manages its own)', async () => {
  const { gh, edits } = fakeGh({
    prs: [{ number: 14, labels: [{ name: 'do-not-merge' }] }],
    refs: { 14: [45] }, issues: { 45: ['in-progress'] },  // not blocking
  });
  const r = await runIssueGate({ gh, repo: 'o/r', enabled: true });
  assert.deepEqual(r.held, []); assert.deepEqual(r.cleared, []);
  assert.equal(edits.length, 0, 'never removes do-not-merge');
});
