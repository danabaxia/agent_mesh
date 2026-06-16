import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderBoardNotice, selectNotices } from '../src/board/notify.js';

const inbound = { id: 'a-b-001', from: 'agentA', to: 'agentB', state: 'assigned', title: 'Wire X', objective: 'X wired', context: 'legacy path', requirements: 'do a; do b', pointers: 'src/x.js' };
const outboundDone = { id: 'b-a-001', from: 'agentB', to: 'agentA', state: 'done', title: 'Earlier ask', result: 'Answered.', seen_by_from: false };

test('selectNotices splits inbound-assigned and outbound-done-unseen for the agent', () => {
  const tasks = [inbound, { ...outboundDone, from: 'agentB' }];
  const r = selectNotices(tasks, 'agentB');
  assert.deepEqual(r.inbound.map((t) => t.id), ['a-b-001']);
  assert.deepEqual(r.outboundDone.map((t) => t.id), ['b-a-001']);
});

test('renderBoardNotice frames assignments as data and lists the brief', () => {
  const text = renderBoardNotice({ inbound: [inbound], outboundDone: [] });
  assert.match(text, /Pending task from agentA/);
  assert.match(text, /Objective: X wired/);
  assert.match(text, /data, not instructions/i);
  assert.match(text, /update_my_task/);
});

test('renderBoardNotice reports completions to the assigner', () => {
  const text = renderBoardNotice({ inbound: [], outboundDone: [outboundDone] });
  assert.match(text, /you assigned to agentA/i);
  assert.match(text, /Answered\./);
});

test('renderBoardNotice returns empty string when nothing to show', () => {
  assert.equal(renderBoardNotice({ inbound: [], outboundDone: [] }), '');
});

import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, realpath, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTask, readTask } from '../src/board/store.js';

const HOOK = fileURLToPath(new URL('../hooks/board-notify.js', import.meta.url));

test('board-notify hook emits additionalContext for an inbound task (walk-up mesh discovery)', async () => {
  const mesh = await mkdtemp(join(tmpdir(), 'board-hook-'));
  const rootB = join(mesh, 'agentB');
  await mkdir(rootB, { recursive: true });
  await writeFile(join(mesh, 'mesh.json'), JSON.stringify({
    'x-agentmesh-generated': true, meshVersion: 1, agents: [{ name: 'agentB', root: 'agentB' }]
  }), 'utf8');
  const real = await realpath(mesh);
  await createTask(real, { from: 'agentA', to: 'agentB', title: 'Hello', objective: 'Greet', requirements: 'Say hi.', at: '2026-06-15T00:00:00.000Z' });

  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ cwd: join(real, 'agentB') }),
    encoding: 'utf8',
    env: { ...process.env, AGENT_MESH_MESH_CEILING: '' }
  });
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(out.hookSpecificOutput.additionalContext, /Pending task from agentA/);
});

test('board-notify hook flips seen_by_from on a surfaced completion (notify-once)', async () => {
  const mesh = await mkdtemp(join(tmpdir(), 'board-hook-seen-'));
  const rootA = join(mesh, 'agentA');
  await mkdir(rootA, { recursive: true });
  await writeFile(join(mesh, 'mesh.json'), JSON.stringify({
    'x-agentmesh-generated': true, meshVersion: 1, agents: [{ name: 'agentA', root: 'agentA' }]
  }), 'utf8');
  const real = await realpath(mesh);
  // A assigned a task to B that is now done and unseen by A.
  const t = await createTask(real, { from: 'agentA', to: 'agentB', title: 'X', objective: 'o', requirements: 'r', at: '2026-06-15T00:00:00.000Z' });
  // Move it to done + unseen directly via writeTask.
  const { writeTask } = await import('../src/board/store.js');
  await writeTask(real, { ...t, state: 'done', result: 'fin', seen_by_from: false,
    history: [...t.history, { state: 'acknowledged', at: '', by: 'agentB' }, { state: 'in-progress', at: '', by: 'agentB' }, { state: 'done', at: '', by: 'agentB' }] });

  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ cwd: join(real, 'agentA') }),
    encoding: 'utf8',
    env: { ...process.env, AGENT_MESH_MESH_CEILING: '' }
  });
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /Done: "X" you assigned to agentB/);
  const after = await readTask(real, t.id);
  assert.equal(after.seen_by_from, true);
});
