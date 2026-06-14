/**
 * test/session-log-terminal.test.js — "⧉ Copy resume command" action (2026-06-13 spec §5).
 *
 * The ⌘ Terminal button that spawned a native terminal was replaced by a
 * copy-to-clipboard flow (EDR-proof). The new contract:
 *   - Button label: "⧉ Copy resume command"
 *   - Click → GET /session/resume-command?id=<openId|latest>
 *   - Empty state → GET /session/resume-command?id=new (bare `claude` command)
 *   - Nothing is spawned; the user pastes in their own terminal.
 *
 * The deprecated terminalLaunchRequest() helper is still exported for API compat
 * but the active click handler no longer uses it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { terminalLaunchRequest } from '../src/dashboard/public/session-log.js';

// ── terminalLaunchRequest: still exported for API back-compat ────────────────
// (no longer used by the active click handler; kept for any callers that
// built on the old open-terminal flow)

test('terminalLaunchRequest (deprecated): open session → resume path via open-terminal', () => {
  assert.deepEqual(terminalLaunchRequest('abc-123'), {
    kind: 'resume',
    path: '/session/abc-123/open-terminal'
  });
});

test('terminalLaunchRequest (deprecated): resume path encodes the session id', () => {
  assert.deepEqual(terminalLaunchRequest('id with space'), {
    kind: 'resume',
    path: '/session/id%20with%20space/open-terminal'
  });
});

test('terminalLaunchRequest (deprecated): empty state → seed via agent-level shell plan/launch', () => {
  for (const empty of [null, undefined, '']) {
    assert.deepEqual(terminalLaunchRequest(empty), {
      kind: 'seed',
      planPath: '/shell/plan',
      launchPath: '/shell/launch'
    });
  }
});

// ── new contract: copy-to-clipboard via /session/resume-command ──────────────

test('new contract: button label is "⧉ Copy resume command" (not ⌘ Terminal)', async () => {
  const { readFile } = await import('node:fs/promises');
  const { resolve } = await import('node:path');
  const src = await readFile(resolve('src/dashboard/public/session-log.js'), 'utf8');
  assert.ok(src.includes('⧉ Copy resume command'), 'button label must be "⧉ Copy resume command"');
  // The active click handler (#sl-term onclick) must use copyResume, not the old terminalLaunchRequest
  assert.ok(src.includes("onclick = () => copyResume"), 'sl-term onclick must call copyResume');
});

test('new contract: click handler calls /session/resume-command (not open-terminal)', async () => {
  const { readFile } = await import('node:fs/promises');
  const { resolve } = await import('node:path');
  const src = await readFile(resolve('src/dashboard/public/session-log.js'), 'utf8');
  // The copyResume function must use the resume-command endpoint
  assert.ok(src.includes('/session/resume-command'), 'copyResume must call /session/resume-command');
  // copyResume is wired to the #sl-term button click
  assert.ok(src.includes('copyResume'), 'copyResume function must be present');
});

test('new contract: empty-state text guides copy-paste (not ⌘ Terminal launch)', async () => {
  const { readFile } = await import('node:fs/promises');
  const { resolve } = await import('node:path');
  const src = await readFile(resolve('src/dashboard/public/session-log.js'), 'utf8');
  assert.ok(
    src.includes('Copy the command below and run it in your terminal'),
    'empty-state must say "Copy the command below..."'
  );
});
