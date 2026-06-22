import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchAction, DispatchError } from '../src/concierge/dispatch.js';

const peers = ['tester', 'triager'];

test('unknown action rejected before any side effect', async () => {
  let touched = false;
  await assert.rejects(() => dispatchAction({ action: 'rm_rf', payload: {}, meshRoot: '/x',
    deps: { runGh: async () => { touched = true; }, broker: { send: async () => { touched = true; } },
      createTask: async () => { touched = true; }, peers } }), (e) => e instanceof DispatchError && e.status === 400);
  assert.equal(touched, false);
});

test('file_issue rejects a disallowed label before any gh spawn', async () => {
  let touched = false;
  await assert.rejects(() => dispatchAction({ action: 'file_issue',
    payload: { title: 'T', body: 'b', labels: ['idea', 'evil'] }, meshRoot: '/x',
    deps: { runGh: async () => { touched = true; return { url: 'u' }; }, broker: { send: async () => {} },
      createTask: async () => {}, peers } }), (e) => e instanceof DispatchError && e.status === 400);
  assert.equal(touched, false, 'gh never spawned on a bad label');
});

test('file_issue runs gh with the allowlisted labels', async () => {
  let args = null;
  const out = await dispatchAction({ action: 'file_issue',
    payload: { title: 'T', body: 'b', labels: ['idea'] }, meshRoot: '/x',
    deps: { runGh: async (a) => { args = a; return { url: 'u' }; }, broker: { send: async () => {} },
      createTask: async () => {}, peers } });
  assert.deepEqual(args.labels, ['idea']);
  assert.equal(out.url, 'u');
});

test('assign_task rejects a non-peer, writes board for a peer with from=concierge', async () => {
  let created = null;
  await assert.rejects(() => dispatchAction({ action: 'assign_task',
    payload: { peer: 'ghost', title: 'T', objective: 'o' }, meshRoot: '/x',
    deps: { runGh: async () => {}, broker: { send: async () => {} }, createTask: async () => {}, peers } }),
    (e) => e.status === 400);
  const out = await dispatchAction({ action: 'assign_task',
    payload: { peer: 'tester', title: 'T', objective: 'o' }, meshRoot: '/x',
    deps: { runGh: async () => {}, broker: { send: async () => {} },
      createTask: async (root, t) => { created = t; return { id: 'tester-001' }; }, peers } });
  assert.equal(created.from, 'concierge');
  assert.equal(created.to, 'tester');
  assert.equal(out.task_id, 'tester-001');
});

test('ask_peer_rerun sends ask via broker to an allowlisted peer', async () => {
  let sent = null;
  const out = await dispatchAction({ action: 'ask_peer_rerun',
    payload: { peer: 'tester', task: 're-run the suite' }, meshRoot: '/x',
    deps: { runGh: async () => {}, createTask: async () => {},
      broker: { send: async (a) => { sent = a; return { task: { artifacts: [{ name: 'summary', parts: [{ text: 'done' }] }] } }; } }, peers } });
  assert.equal(sent.agentName, 'tester');
  assert.equal(sent.mode, 'ask');
  assert.equal(out.summary, 'done', 'reads the Task artifact text, not task.summary');
});
