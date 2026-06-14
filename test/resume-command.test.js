import test from 'node:test';
import assert from 'node:assert/strict';
import { buildResumeCommand } from '../src/dashboard/resume-command.js';

test('win32: PowerShell-quoted cd; resume with exact id; embedded quotes doubled', () => {
  const c = buildResumeCommand({ agentRoot: "C:\\agents\\o'brien lab", sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', mode: 'resume', platform: 'win32' });
  assert.equal(c.shell, 'powershell');
  assert.equal(c.command, "cd 'C:\\agents\\o''brien lab'; claude --resume aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
});

test('posix: && chaining and single-quote escaping', () => {
  const c = buildResumeCommand({ agentRoot: "/srv/o'brien lab", sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', mode: 'resume', platform: 'linux' });
  assert.equal(c.shell, 'sh');
  assert.equal(c.command, "cd '/srv/o'\\''brien lab' && claude --resume aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
});

test('mode new → bare claude; mode seed → --session-id (reserved canonical first launch)', () => {
  assert.match(buildResumeCommand({ agentRoot: '/a', mode: 'new', platform: 'linux' }).command, /&& claude$/);
  assert.match(buildResumeCommand({ agentRoot: '/a', sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', mode: 'seed', platform: 'linux' }).command, /--session-id aaaaaaaa/);
});

test('invalid session id throws (defense in depth — route validates first)', () => {
  assert.throws(() => buildResumeCommand({ agentRoot: '/a', sessionId: 'x; rm -rf /', mode: 'resume', platform: 'linux' }), /bad session id/);
});
