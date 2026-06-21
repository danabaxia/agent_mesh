import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchMemoryAutomerge } from '../src/automerge/memory-dispatch.js';

function recordingGh(map) {
  const calls = [];
  return { calls, gh: async (args) => { calls.push(args); return map(args) ?? '[]'; } };
}

test('no open memory:promote PRs → does NOT dispatch the workflow (no wasted Actions run)', async () => {
  const { calls, gh } = recordingGh((a) => (a.includes('pr') ? '[]' : ''));
  const r = await dispatchMemoryAutomerge({ gh, repo: 'o/r' });
  assert.deepEqual(r, { dispatched: false, openCount: 0 });
  assert.ok(!calls.some((a) => a.includes('workflow')), 'must not call `gh workflow run` when no memory PRs');
});

test('open memory:promote PRs → dispatches the workflow', async () => {
  const { calls, gh } = recordingGh((a) =>
    a.includes('pr') ? JSON.stringify([{ number: 1 }, { number: 2 }]) : '');
  const r = await dispatchMemoryAutomerge({ gh, repo: 'o/r' });
  assert.equal(r.dispatched, true);
  assert.equal(r.openCount, 2);
  const wf = calls.find((a) => a.includes('workflow'));
  assert.ok(wf, 'must call `gh workflow run`');
  assert.ok(wf.includes('run') && wf.includes('dev-mesh-memory-automerge.yml') && wf.includes('o/r'));
});

test('list query is label-scoped to memory:promote, open, same repo', async () => {
  const { calls, gh } = recordingGh(() => '[]');
  await dispatchMemoryAutomerge({ gh, repo: 'o/r' });
  const list = calls.find((a) => a.includes('pr') && a.includes('list'));
  assert.ok(list.includes('--label') && list.includes('memory:promote'));
  assert.ok(list.includes('--state') && list.includes('open'));
  assert.ok(list.includes('--repo') && list.includes('o/r'));
});

test('a failed list returns {dispatched:false} and never throws (loop-safe)', async () => {
  const gh = async () => { throw new Error('gh boom'); };
  const r = await dispatchMemoryAutomerge({ gh, repo: 'o/r' });
  assert.equal(r.dispatched, false);
  assert.match(r.error, /boom/);
});
