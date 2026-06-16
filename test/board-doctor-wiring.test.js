import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBoardNotifyHook } from '../src/builder/doctor.js';

test('syncBoardNotifyHook installs a SessionStart exec-form hook, preserving authored content', async () => {
  const agentRoot = await mkdtemp(join(tmpdir(), 'board-doctor-'));
  await mkdir(join(agentRoot, '.claude'), { recursive: true });
  await writeFile(join(agentRoot, '.claude', 'settings.json'),
    JSON.stringify({ env: { FOO: 'bar' }, hooks: {} }), 'utf8');

  const fixed = [], flagged = [];
  await syncBoardNotifyHook({ name: 'agentB', agentRoot, peers: ['agentA'] }, true, fixed, flagged);

  const doc = JSON.parse(await readFile(join(agentRoot, '.claude', 'settings.json'), 'utf8'));
  assert.equal(doc.env.FOO, 'bar');
  const entry = doc.hooks.SessionStart[0].hooks[0];
  assert.equal(entry.type, 'command');
  assert.equal(entry.command, process.execPath);
  assert.ok(entry.args[0].replace(/\\/g, '/').endsWith('hooks/board-notify.js'));
  assert.equal(fixed.length, 1);
});

test('syncBoardNotifyHook is idempotent (second run is a no-op)', async () => {
  const agentRoot = await mkdtemp(join(tmpdir(), 'board-doctor-'));
  const fixed = [];
  await syncBoardNotifyHook({ name: 'agentB', agentRoot, peers: ['agentA'] }, true, fixed, []);
  const fixed2 = [];
  await syncBoardNotifyHook({ name: 'agentB', agentRoot, peers: ['agentA'] }, true, fixed2, []);
  assert.deepEqual(fixed2, []);
});

test('syncBoardNotifyHook removes the hook when the agent has no peers', async () => {
  const agentRoot = await mkdtemp(join(tmpdir(), 'board-doctor-'));
  await syncBoardNotifyHook({ name: 'agentB', agentRoot, peers: ['agentA'] }, true, [], []);
  await syncBoardNotifyHook({ name: 'agentB', agentRoot, peers: [] }, true, [], []);
  const doc = JSON.parse(await readFile(join(agentRoot, '.claude', 'settings.json'), 'utf8'));
  assert.equal((doc.hooks?.SessionStart ?? []).length, 0);
});

test('syncBoardNotifyHook preserves an author SessionStart hook while adding/removing ours', async () => {
  const agentRoot = await mkdtemp(join(tmpdir(), 'board-doctor-'));
  await mkdir(join(agentRoot, '.claude'), { recursive: true });
  const authorHook = { matcher: '*', hooks: [{ type: 'command', command: 'echo', args: ['hi'] }] };
  await writeFile(join(agentRoot, '.claude', 'settings.json'),
    JSON.stringify({ hooks: { SessionStart: [authorHook] } }), 'utf8');
  // add ours
  await syncBoardNotifyHook({ name: 'agentB', agentRoot, peers: ['agentA'] }, true, [], []);
  let doc = JSON.parse(await readFile(join(agentRoot, '.claude', 'settings.json'), 'utf8'));
  assert.equal(doc.hooks.SessionStart.length, 2);
  // remove ours (no peers) — author hook survives
  await syncBoardNotifyHook({ name: 'agentB', agentRoot, peers: [] }, true, [], []);
  doc = JSON.parse(await readFile(join(agentRoot, '.claude', 'settings.json'), 'utf8'));
  assert.equal(doc.hooks.SessionStart.length, 1);
  assert.equal(doc.hooks.SessionStart[0].hooks[0].command, 'echo');
});
