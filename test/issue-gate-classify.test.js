import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyIssueGate } from '../src/automerge/issue-gate-sweep.js';

function fakeGh(map) {
  const calls = [];
  return { calls, gh: async (args) => { calls.push(args.join(' ')); return map(args) ?? '[]'; } };
}

test('classifyIssueGate: holds a PR whose linked issue is blocked; clears one that is not; issues NO pr edit', async () => {
  const { calls, gh } = fakeGh((args) => {
    const a = args.join(' ');
    if (a.includes('pr list')) return JSON.stringify([{ number: 1, labels: [] }, { number: 2, labels: [{ name: 'blocked-by-issue' }] }]);
    if (a.includes('pr view 1')) return JSON.stringify({ closingIssuesReferences: [{ number: 10 }] });
    if (a.includes('pr view 2')) return JSON.stringify({ closingIssuesReferences: [{ number: 20 }] });
    if (a.includes('issue view 10')) return JSON.stringify({ labels: [{ name: 'blocked' }] });
    if (a.includes('issue view 20')) return JSON.stringify({ labels: [{ name: 'ready' }] });
    return '[]';
  });
  const r = await classifyIssueGate({ gh, repo: 'o/r' });
  assert.deepEqual(r.held, [1]);
  assert.deepEqual(r.cleared, [2]);
  assert.ok(!calls.some((c) => c.includes('pr edit')), 'must not edit labels');
});

test('classifyIssueGate: pr list failure → {error}, never throws', async () => {
  const r = await classifyIssueGate({ gh: async () => { throw new Error('boom'); }, repo: 'o/r' });
  assert.equal(r.held.length, 0);
  assert.match(r.error, /boom/);
});
