import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  boardDir, createTask, readTask, listTasks, writeTask, markSeenByFrom
} from '../src/board/store.js';

async function tmpMesh() {
  return mkdtemp(join(tmpdir(), 'board-store-'));
}

test('boardDir is <meshRoot>/mesh/board/tasks', () => {
  assert.equal(boardDir('/m'), join('/m', 'mesh', 'board', 'tasks'));
});

test('createTask writes a file with framework-stamped fields and assigned state', async () => {
  const mesh = await tmpMesh();
  const t = await createTask(mesh, {
    from: 'agentA', to: 'agentB',
    title: 'Do the thing', objective: 'Thing is done', requirements: 'Step 1; step 2.',
    at: '2026-06-15T00:00:00.000Z'
  });
  assert.equal(t.from, 'agentA');
  assert.equal(t.to, 'agentB');
  assert.equal(t.state, 'assigned');
  assert.equal(t.seen_by_from, false);
  assert.equal(t.id, 'agentA-agentB-001');
  assert.equal(t.history[0].state, 'assigned');
  const onDisk = JSON.parse(await readFile(join(boardDir(mesh), 'agentA-agentB-001.json'), 'utf8'));
  assert.deepEqual(onDisk, t);
});

test('createTask increments the per-pair counter (no collision)', async () => {
  const mesh = await tmpMesh();
  const a = await createTask(mesh, { from: 'x', to: 'y', title: 't', objective: 'o', requirements: 'r', at: '2026-06-15T00:00:00.000Z' });
  const b = await createTask(mesh, { from: 'x', to: 'y', title: 't', objective: 'o', requirements: 'r', at: '2026-06-15T00:00:01.000Z' });
  assert.equal(a.id, 'x-y-001');
  assert.equal(b.id, 'x-y-002');
});

test('listTasks reads all tasks; readTask reads one by id', async () => {
  const mesh = await tmpMesh();
  await createTask(mesh, { from: 'a', to: 'b', title: 't', objective: 'o', requirements: 'r', at: '2026-06-15T00:00:00.000Z' });
  const all = await listTasks(mesh);
  assert.equal(all.length, 1);
  const one = await readTask(mesh, 'a-b-001');
  assert.equal(one.id, 'a-b-001');
  assert.equal(await readTask(mesh, 'nope'), null);
});

test('listTasks on an absent board returns []', async () => {
  const mesh = await tmpMesh();
  assert.deepEqual(await listTasks(mesh), []);
});

test('writeTask round-trips an updated record atomically', async () => {
  const mesh = await tmpMesh();
  const t = await createTask(mesh, { from: 'a', to: 'b', title: 't', objective: 'o', requirements: 'r', at: '2026-06-15T00:00:00.000Z' });
  await writeTask(mesh, { ...t, state: 'acknowledged' });
  assert.equal((await readTask(mesh, t.id)).state, 'acknowledged');
  const left = (await readdir(boardDir(mesh))).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(left, []);
});

test('markSeenByFrom flips the flag once', async () => {
  const mesh = await tmpMesh();
  const t = await createTask(mesh, { from: 'a', to: 'b', title: 't', objective: 'o', requirements: 'r', at: '2026-06-15T00:00:00.000Z' });
  await markSeenByFrom(mesh, t.id);
  assert.equal((await readTask(mesh, t.id)).seen_by_from, true);
  await markSeenByFrom(mesh, t.id);
  assert.equal((await readTask(mesh, t.id)).seen_by_from, true);
});
