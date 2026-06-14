// test/cold-start.test.js — cold-start proposals (spec §4/§11). Pure, no spawn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildColdStartProposals } from '../src/dashboard/cold-start.js';

const UUID_A = 'aaaaaaaa-1111-4222-8333-444444444444';
const UUID_B = 'bbbbbbbb-1111-4222-8333-444444444444';
const NEW = 'cccccccc-1111-4222-8333-444444444444';

const manifest = {
  version: 1,
  sessions: [
    { id: UUID_A, status: 'active', l0: 'deploy billing', task_label: 'deploy' },
    { id: UUID_B, status: 'archived', l0: 'old task', task_label: 'old' },
    { id: 'not-a-uuid', status: 'active', l0: 'legacy', task_label: null }
  ]
};

test('open-new is the default: fresh UUID via --session-id, never --continue', () => {
  const { openNew } = buildColdStartProposals({ manifest, agentRoot: '/agents/app', newId: NEW, platform: 'sh' });
  assert.equal(openNew.kind, 'open-new');
  assert.equal(openNew.session_id, NEW);
  assert.match(openNew.command, /claude --session-id cccccccc-1111-4222-8333-444444444444/);
  assert.doesNotMatch(openNew.command, /--continue/);
});

test('resume proposals: ONLY active, UUID-valid sessions → --resume <id>', () => {
  const { resume } = buildColdStartProposals({ manifest, agentRoot: '/agents/app', newId: NEW, platform: 'sh' });
  assert.deepEqual(resume.map((r) => r.session_id), [UUID_A]);   // archived + non-uuid excluded
  assert.match(resume[0].command, /claude --resume aaaaaaaa-1111-4222-8333-444444444444/);
  assert.equal(resume[0].l0, 'deploy billing');
  assert.equal(resume[0].task_label, 'deploy');
});

test('windows: powershell quoting for the cwd', () => {
  const { openNew } = buildColdStartProposals({ manifest, agentRoot: 'C:\\agents\\app', newId: NEW, platform: 'win32' });
  assert.equal(openNew.shell, 'powershell');
  assert.match(openNew.command, /cd 'C:\\agents\\app'; claude --session-id/);
});

test('empty manifest: open-new only, no resume options', () => {
  const { openNew, resume } = buildColdStartProposals({ manifest: { version: 1, sessions: [] }, agentRoot: '/a', newId: NEW });
  assert.ok(openNew);
  assert.deepEqual(resume, []);
});
