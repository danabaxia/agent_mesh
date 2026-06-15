import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge } from '../src/a2a/peer-bridge.js';
import { listTasks, createTask } from '../src/board/store.js';

async function meshFixture() {
  const mesh = await mkdtemp(join(tmpdir(), 'board-bridge-'));
  const rootA = join(mesh, 'agentA');
  const rootB = join(mesh, 'agentB');
  await mkdir(rootA, { recursive: true });
  await mkdir(rootB, { recursive: true });
  await writeFile(join(mesh, 'mesh.json'), JSON.stringify({
    'x-agentmesh-generated': true, meshVersion: 1,
    agents: [{ name: 'agentA', root: 'agentA' }, { name: 'agentB', root: 'agentB' }]
  }), 'utf8');
  await writeFile(join(rootA, 'registry.json'), JSON.stringify({
    'x-agentmesh-generated': true,
    peers: { agentB: { root: join(mesh, 'agentB'), spawn: { command: 'node', args: ['noop'] } } }
  }), 'utf8');
  const realMesh = await realpath(mesh);
  return { mesh: realMesh, rootA: await realpath(rootA), rootB: await realpath(rootB), env: { AGENT_MESH_MESH_CEILING: realMesh } };
}

test('create_task_for_peer writes an assigned task with framework-stamped from/to', async () => {
  const { mesh, rootA, env } = await meshFixture();
  const bridge = createBridge({ root: rootA, env });
  const res = await bridge.createTaskForPeer({ peer: 'agentB', title: 'Wire X', objective: 'X is wired', requirements: 'Do a, then b.' });
  assert.equal(res.ok, true);
  assert.equal(res.to, 'agentB');
  assert.equal(res.state, 'assigned');
  const tasks = await listTasks(mesh);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].from, 'agentA');
  assert.equal(tasks[0].to, 'agentB');
});

test('create_task_for_peer refuses an unknown/unmarked peer (data, no throw)', async () => {
  const { rootA, env } = await meshFixture();
  const bridge = createBridge({ root: rootA, env });
  const res = await bridge.createTaskForPeer({ peer: 'ghost', title: 't', objective: 'o', requirements: 'r' });
  assert.equal(res.ok, false);
  assert.equal(res.error_code, 'bad_peer');
});

test('create_task_for_peer enforces required brief fields', async () => {
  const { rootA, env } = await meshFixture();
  const bridge = createBridge({ root: rootA, env });
  const missing = await bridge.createTaskForPeer({ peer: 'agentB', title: 't' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error_code, 'bad_input');
});

test('update_my_task: only the `to` agent may advance', async () => {
  const { mesh, rootA, rootB, env } = await meshFixture();
  const t = await createTask(mesh, { from: 'agentA', to: 'agentB', title: 't', objective: 'o', requirements: 'r', at: '2026-06-15T00:00:00.000Z' });
  const asA = createBridge({ root: rootA, env });
  const denied = await asA.updateMyTask({ task_id: t.id, state: 'acknowledged' });
  assert.equal(denied.ok, false);
  assert.equal(denied.error_code, 'not_assignee');
  const asB = createBridge({ root: rootB, env });
  const ok = await asB.updateMyTask({ task_id: t.id, state: 'acknowledged' });
  assert.equal(ok.ok, true);
  assert.equal(ok.state, 'acknowledged');
});

test('update_my_task rejects an invalid transition as data', async () => {
  const { mesh, rootB, env } = await meshFixture();
  const t = await createTask(mesh, { from: 'agentA', to: 'agentB', title: 't', objective: 'o', requirements: 'r', at: '2026-06-15T00:00:00.000Z' });
  const asB = createBridge({ root: rootB, env });
  const res = await asB.updateMyTask({ task_id: t.id, state: 'done' });
  assert.equal(res.ok, false);
  assert.equal(res.error_code, 'invalid_transition');
});

test('list_my_tasks returns only tasks addressed to the caller', async () => {
  const { mesh, rootB, env } = await meshFixture();
  await createTask(mesh, { from: 'agentA', to: 'agentB', title: 'mine', objective: 'o', requirements: 'r', at: '2026-06-15T00:00:00.000Z' });
  await createTask(mesh, { from: 'agentB', to: 'agentA', title: 'theirs', objective: 'o', requirements: 'r', at: '2026-06-15T00:00:01.000Z' });
  const asB = createBridge({ root: rootB, env });
  const res = await asB.listMyTasks();
  assert.equal(res.ok, true);
  assert.equal(res.tasks.length, 1);
  assert.equal(res.tasks[0].title, 'mine');
});

test('board verbs refuse with no_mesh when env has no mesh root', async () => {
  const { rootA } = await meshFixture();
  const bridge = createBridge({ root: rootA, env: {} });
  assert.equal((await bridge.createTaskForPeer({ peer: 'agentB', title: 't', objective: 'o', requirements: 'r' })).error_code, 'no_mesh');
  assert.equal((await bridge.listMyTasks()).error_code, 'no_mesh');
  assert.equal((await bridge.updateMyTask({ task_id: 'x', state: 'acknowledged' })).error_code, 'no_mesh');
});
