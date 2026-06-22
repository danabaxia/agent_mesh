import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchAction, DispatchError } from '../src/concierge/dispatch.js';

const peers = ['tester', 'triager', 'orchestrator'];

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

test('assign_task rejects a non-peer before any board write', async () => {
  let touched = false;
  await assert.rejects(() => dispatchAction({ action: 'assign_task',
    payload: { peer: 'ghost', title: 'T', objective: 'o' }, meshRoot: '/x',
    deps: { runGh: async () => {}, broker: { send: async () => {} }, createTask: async () => { touched = true; }, peers } }),
    (e) => e.status === 400);
  assert.equal(touched, false);
});

test('assign_task routes the durable ticket to the board lead (orchestrator), from=concierge', async () => {
  let created = null;
  const out = await dispatchAction({ action: 'assign_task',
    payload: { peer: 'orchestrator', title: 'T', objective: 'o' }, meshRoot: '/x',
    deps: { runGh: async () => {}, broker: { send: async () => {} },
      createTask: async (root, t) => { created = t; return { id: 'orchestrator-001' }; }, peers } });
  assert.equal(created.from, 'concierge');
  assert.equal(created.to, 'orchestrator');
  assert.equal(out.task_id, 'orchestrator-001');
});

test('assign_task to a specialist (no autonomous board driver) is REJECTED — points at ask_peer_rerun', async () => {
  // Regression: a durable ticket to a non-lead specialist has no headless driver
  // (only the orchestrator runs the board-drive job) → it stalls at acknowledged
  // forever. The dispatcher must refuse it, not silently create a stuck ticket.
  let touched = false;
  await assert.rejects(() => dispatchAction({ action: 'assign_task',
    payload: { peer: 'tester', title: 'T', objective: 'o' }, meshRoot: '/x',
    deps: { runGh: async () => {}, broker: { send: async () => {} }, createTask: async () => { touched = true; }, peers } }),
    (e) => { assert.equal(e.status, 400); assert.match(e.message, /orchestrator/); assert.match(e.message, /ask_peer_rerun/); return true; });
  assert.equal(touched, false, 'no driverless ticket is created');
});

test('the board lead is configurable via deps.boardLead', async () => {
  let created = null;
  await dispatchAction({ action: 'assign_task',
    payload: { peer: 'triager', title: 'T', objective: 'o' }, meshRoot: '/x',
    deps: { runGh: async () => {}, broker: { send: async () => {} }, boardLead: 'triager',
      createTask: async (root, t) => { created = t; return { id: 'triager-001' }; }, peers } });
  assert.equal(created.to, 'triager');
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
