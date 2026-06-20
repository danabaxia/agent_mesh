import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planDeploySync } from '../src/dev-society/deploy-sync.js';
import { runDeploySyncOnce, makeFileState } from '../scripts/dev-society-deploy-sync.mjs';

const AT = () => new Date('2026-06-20T07:00:00.000Z');

test('planDeploySync: independent reset and restart', () => {
  assert.deepEqual(planDeploySync({ head: 'a', target: 'b', lastRestartedTarget: 'a' }), { reset: true, restart: true });
  assert.deepEqual(planDeploySync({ head: 'b', target: 'b', lastRestartedTarget: 'b' }), { reset: false, restart: false });
  // retry-after-failed-restart: tree already at target, but daemon not yet restarted onto it
  assert.deepEqual(planDeploySync({ head: 'b', target: 'b', lastRestartedTarget: 'a' }), { reset: false, restart: true });
  // empty target → both false
  assert.deepEqual(planDeploySync({ head: 'a', target: '', lastRestartedTarget: '' }), { reset: false, restart: false });
});

// Fake git keyed on the first args; records the commands issued.
function fakeGit({ head, target, fetchThrows }) {
  const calls = [];
  const git = async (_path, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return head;
    if (args[0] === 'fetch') { if (fetchThrows) throw new Error('network down'); return ''; }
    if (args[0] === 'rev-parse' && args[1] === 'origin/main') return target;
    if (args[0] === 'reset') return '';
    return '';
  };
  return { git, calls };
}

test('runDeploySyncOnce: advance resets, restarts, and persists target', async () => {
  const { git, calls } = fakeGit({ head: 'old', target: 'new' });
  let restarts = 0; const writes = [];
  const rec = await runDeploySyncOnce({
    deployPath: '/x', git, restart: async () => { restarts++; },
    readState: () => 'old', writeState: (t) => writes.push(t), now: AT,
  });
  assert.equal(rec.action, 'advanced');
  assert.ok(calls.includes('reset --hard origin/main'));
  assert.equal(restarts, 1);
  assert.deepEqual(writes, ['new']);
});

test('runDeploySyncOnce: already current + already restarted → no reset, no restart', async () => {
  const { git, calls } = fakeGit({ head: 'cur', target: 'cur' });
  let restarts = 0; const writes = [];
  const rec = await runDeploySyncOnce({ deployPath: '/x', git, restart: async () => { restarts++; },
    readState: () => 'cur', writeState: (t) => writes.push(t), now: AT });
  assert.equal(rec.action, 'up_to_date');
  assert.ok(!calls.includes('reset --hard origin/main'));
  assert.equal(restarts, 0);
  assert.deepEqual(writes, []);
});

test('runDeploySyncOnce: restart failure does NOT persist (so next tick retries)', async () => {
  const { git } = fakeGit({ head: 'old', target: 'new' });
  const writes = [];
  const rec = await runDeploySyncOnce({ deployPath: '/x', git,
    restart: async () => { throw new Error('launchctl boom'); },
    readState: () => 'old', writeState: (t) => writes.push(t), now: AT });
  assert.equal(rec.action, 'error');
  assert.deepEqual(writes, []);  // lastRestartedTarget unchanged → retried later
});

test('runDeploySyncOnce: git fetch failure → error, no reset, no restart', async () => {
  const { git, calls } = fakeGit({ head: 'old', target: 'new', fetchThrows: true });
  let restarts = 0;
  const rec = await runDeploySyncOnce({ deployPath: '/x', git, restart: async () => { restarts++; },
    readState: () => 'old', writeState: () => {}, now: AT });
  assert.equal(rec.action, 'error');
  assert.ok(!calls.includes('reset --hard origin/main'));
  assert.equal(restarts, 0);
});

test('makeFileState round-trips the scalar contract atomically', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-'));
  const sp = join(dir, '.dev-society', 'deploy-sync-state.json');
  const s = makeFileState(sp);
  assert.equal(s.readState(), '');           // missing → ''
  s.writeState('abc123');
  assert.equal(s.readState(), 'abc123');
  assert.equal(JSON.parse(readFileSync(sp, 'utf8')).lastRestartedTarget, 'abc123');
});
