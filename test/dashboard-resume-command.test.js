import test from 'node:test';
import assert from 'node:assert/strict';
import { buildResumeCommand } from '../src/dashboard/resume-command.js';
const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
test('no mode ever emits the --continue recency heuristic (the 2026-06-09 regression net)', () => {
  for (const mode of ['new', 'seed', 'resume']) {
    const c = buildResumeCommand({ agentRoot: '/a', sessionId: mode === 'new' ? null : ID, mode, platform: 'linux' });
    assert.doesNotMatch(c.command, /--continue\b/, `mode ${mode} must never use --continue`);
  }
});
test('resume mode → --resume <id>; seed mode → --session-id <id>', () => {
  assert.match(buildResumeCommand({ agentRoot: '/a', sessionId: ID, mode: 'resume', platform: 'linux' }).command, /--resume aaaaaaaa-/);
  assert.match(buildResumeCommand({ agentRoot: '/a', sessionId: ID, mode: 'seed', platform: 'linux' }).command, /--session-id aaaaaaaa-/);
});
