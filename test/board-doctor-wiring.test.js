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
  await syncBoardNotifyHook({ name: 'agentB', agentRoot }, true, true, fixed, flagged);

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
  await syncBoardNotifyHook({ name: 'agentB', agentRoot }, true, true, fixed, []);
  const fixed2 = [];
  await syncBoardNotifyHook({ name: 'agentB', agentRoot }, true, true, fixed2, []);
  assert.deepEqual(fixed2, []);
});

test('syncBoardNotifyHook removes the hook when the agent has no peers', async () => {
  const agentRoot = await mkdtemp(join(tmpdir(), 'board-doctor-'));
  await syncBoardNotifyHook({ name: 'agentB', agentRoot }, true, true, [], []);
  await syncBoardNotifyHook({ name: 'agentB', agentRoot }, false, true, [], []);
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
  await syncBoardNotifyHook({ name: 'agentB', agentRoot }, true, true, [], []);
  let doc = JSON.parse(await readFile(join(agentRoot, '.claude', 'settings.json'), 'utf8'));
  assert.equal(doc.hooks.SessionStart.length, 2);
  // remove ours (no longer participates) — author hook survives
  await syncBoardNotifyHook({ name: 'agentB', agentRoot }, false, true, [], []);
  doc = JSON.parse(await readFile(join(agentRoot, '.claude', 'settings.json'), 'utf8'));
  assert.equal(doc.hooks.SessionStart.length, 1);
  assert.equal(doc.hooks.SessionStart[0].hooks[0].command, 'echo');
});

test('syncBoardNotifyHook is idempotent starting from a pre-existing settings file', async () => {
  const agentRoot = await mkdtemp(join(tmpdir(), 'board-doctor-'));
  await mkdir(join(agentRoot, '.claude'), { recursive: true });
  await writeFile(join(agentRoot, '.claude', 'settings.json'), JSON.stringify({ env: { A: '1' } }), 'utf8');
  await syncBoardNotifyHook({ name: 'agentB', agentRoot }, true, true, [], []);
  const fixed2 = [];
  await syncBoardNotifyHook({ name: 'agentB', agentRoot }, true, true, fixed2, []);
  assert.deepEqual(fixed2, []);
});

test('syncBoardNotifyHook does not mistake an author hook whose later arg ends in board-notify.js', async () => {
  const agentRoot = await mkdtemp(join(tmpdir(), 'board-doctor-'));
  await mkdir(join(agentRoot, '.claude'), { recursive: true });
  const authorHook = { matcher: '*', hooks: [{ type: 'command', command: process.execPath, args: ['--script', 'hooks/board-notify.js'] }] };
  await writeFile(join(agentRoot, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [authorHook] } }), 'utf8');
  // remove ours (no longer participates): the author hook (board-notify.js only in args[1]) must SURVIVE
  await syncBoardNotifyHook({ name: 'agentB', agentRoot }, false, true, [], []);
  const doc = JSON.parse(await readFile(join(agentRoot, '.claude', 'settings.json'), 'utf8'));
  assert.equal(doc.hooks.SessionStart.length, 1);
  assert.deepEqual(doc.hooks.SessionStart[0].hooks[0].args, ['--script', 'hooks/board-notify.js']);
});
