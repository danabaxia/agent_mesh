import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planDeploySync } from '../src/dev-society/deploy-sync.js';
import { runDeploySyncOnce, makeFileState, makeMultiRestart } from '../scripts/dev-society-deploy-sync.mjs';

const AT = () => new Date('2026-06-20T07:00:00.000Z');

test('planDeploySync: independent reset and restart', () => {
  assert.deepEqual(planDeploySync({ head: 'a', target: 'b', lastRestartedTarget: 'a' }), { reset: true, restart: true, deferredRestart: false });
  assert.deepEqual(planDeploySync({ head: 'b', target: 'b', lastRestartedTarget: 'b' }), { reset: false, restart: false, deferredRestart: false });
  // retry-after-failed-restart: tree already at target, but daemon not yet restarted onto it
  assert.deepEqual(planDeploySync({ head: 'b', target: 'b', lastRestartedTarget: 'a' }), { reset: false, restart: true, deferredRestart: false });
  // empty target → both false
  assert.deepEqual(planDeploySync({ head: 'a', target: '', lastRestartedTarget: '' }), { reset: false, restart: false, deferredRestart: false });
});

test('planDeploySync: buildBusy defers the restart but still resets', () => {
  // build in flight: reset proceeds, restart is deferred (would otherwise kill the build)
  assert.deepEqual(planDeploySync({ head: 'a', target: 'b', lastRestartedTarget: 'a', buildBusy: true }),
    { reset: true, restart: false, deferredRestart: true });
  // already-reset, restart pending, but busy → still deferred
  assert.deepEqual(planDeploySync({ head: 'b', target: 'b', lastRestartedTarget: 'a', buildBusy: true }),
    { reset: false, restart: false, deferredRestart: true });
  // nothing to restart → not "deferred" even when busy
  assert.deepEqual(planDeploySync({ head: 'b', target: 'b', lastRestartedTarget: 'b', buildBusy: true }),
    { reset: false, restart: false, deferredRestart: false });
});

test('runDeploySyncOnce: defers restart while a build is in flight, then restarts next tick', async () => {
  const { git } = fakeGit({ head: 'a', target: 'b' });
  let restarts = 0; let persisted = '';
  const common = { deployPath: '/d', git, restart: async () => { restarts++; },
    readState: () => persisted, writeState: (t) => { persisted = t; } };
  // tick 1: busy → reset happens, restart deferred, state NOT persisted
  const r1 = await runDeploySyncOnce({ ...common, buildBusy: () => true });
  assert.equal(restarts, 0);
  assert.equal(r1.deferredRestart, true);
  assert.equal(r1.restarted, false);
  assert.equal(persisted, '');
  // tick 2: build done → restart fires, state persisted
  const r2 = await runDeploySyncOnce({ ...common, buildBusy: () => false });
  assert.equal(restarts, 1);
  assert.equal(r2.restarted, true);
  assert.equal(persisted, 'b');
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

test('makeMultiRestart: kicks required then optional, in order', async () => {
  const calls = [];
  const r = makeMultiRestart({ required: ['daemon'], optional: ['dash'], kick: async (l) => { calls.push(l); } });
  await r();
  assert.deepEqual(calls, ['daemon', 'dash']);
});

test('makeMultiRestart: optional failure is swallowed + logged, promise resolves', async () => {
  const logs = [];
  const r = makeMultiRestart({
    required: ['daemon'], optional: ['dash'],
    kick: async (l) => { if (l === 'dash') throw new Error('not loaded'); },
    log: (x) => logs.push(x),
  });
  await r(); // must not throw
  assert.equal(logs.length, 1);
  assert.equal(logs[0].action, 'dashboard_restart_failed');
  assert.equal(logs[0].label, 'dash');
});

test('makeMultiRestart: required failure rejects (so state does not advance)', async () => {
  const r = makeMultiRestart({ required: ['daemon'], optional: ['dash'], kick: async (l) => { if (l === 'daemon') throw new Error('boom'); } });
  await assert.rejects(r, /boom/);
});

test('runDeploySyncOnce: advances state even when the optional (dashboard) kick fails', async () => {
  const git = async (_d, args) => {
    const k = args.join(' ');
    if (k === 'rev-parse HEAD') return 'a';
    if (k === 'rev-parse origin/main') return 'b';
    return '';
  };
  let persisted = '';
  const restart = makeMultiRestart({
    required: ['daemon'], optional: ['dash'],
    kick: async (l) => { if (l === 'dash') throw new Error('not loaded'); },
  });
  const r = await runDeploySyncOnce({
    deployPath: '/d', git, restart,
    readState: () => '', writeState: (t) => { persisted = t; },
    buildBusy: () => false,
  });
  assert.equal(r.restarted, true);
  assert.equal(persisted, 'b');   // daemon kick succeeded → state advanced despite dashboard failure
});
