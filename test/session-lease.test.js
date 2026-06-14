import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateLease, probePid } from '../src/dashboard/session-lease.js';

const SELF = { pid: 100, procStartedAt: 1000 };
const base = { now: 5000, self: SELF, force: false, launchGraceMs: 2000 };
// probe: a map pid→{alive, procStartedAt}
const probeOf = (m) => (pid) => m[pid] || { alive: false, procStartedAt: null };

test('no existing lease → acquire', () => {
  assert.equal(evaluateLease(null, { ...base, probe: probeOf({}) }).action, 'acquire');
});

test('running, wrapper alive-matching → busy', () => {
  const ex = { state: 'running', owner: 'dashboard', pid: 200, procStartedAt: 3000, childPid: 201, childProcStartedAt: 3100 };
  const probe = probeOf({ 200: { alive: true, procStartedAt: 3000 } });
  assert.equal(evaluateLease(ex, { ...base, probe }).action, 'busy');
});

test('running, wrapper dead but child alive-matching → busy (no double-resume)', () => {
  const ex = { state: 'running', owner: 'dashboard', pid: 200, procStartedAt: 3000, childPid: 201, childProcStartedAt: 3100 };
  const probe = probeOf({ 201: { alive: true, procStartedAt: 3100 } });
  assert.equal(evaluateLease(ex, { ...base, probe }).action, 'busy');
});

test('running, both dead → reclaim', () => {
  const ex = { state: 'running', owner: 'dashboard', pid: 200, procStartedAt: 3000, childPid: 201, childProcStartedAt: 3100 };
  assert.equal(evaluateLease(ex, { ...base, probe: probeOf({}) }).action, 'reclaim');
});

test('running, reused PID (start-time newer) → reclaim', () => {
  const ex = { state: 'running', owner: 'dashboard', pid: 200, procStartedAt: 3000, childPid: 201, childProcStartedAt: 3100 };
  const probe = probeOf({ 200: { alive: true, procStartedAt: 9999 }, 201: { alive: true, procStartedAt: 9999 } });
  assert.equal(evaluateLease(ex, { ...base, probe }).action, 'reclaim');
});

test('running busy + force + owned → takeover-kill; external → takeover-refuse', () => {
  const ex = { state: 'running', owner: 'dashboard', pid: 200, procStartedAt: 3000, childPid: 201, childProcStartedAt: 3100, childPgid: 201 };
  const probe = probeOf({ 201: { alive: true, procStartedAt: 3100 } });
  assert.equal(evaluateLease(ex, { ...base, force: true, probe }).action, 'takeover-kill');
  assert.equal(evaluateLease({ ...ex, owner: 'iterm' }, { ...base, force: true, probe }).action, 'takeover-refuse');
});

test('launching, dashboard alive → busy; dead + grace elapsed → reclaim', () => {
  const ex = { state: 'launching', owner: 'dashboard', pid: 200, procStartedAt: 3000, startedAt: 100 };
  assert.equal(evaluateLease(ex, { ...base, probe: probeOf({ 200: { alive: true, procStartedAt: 3000 } }) }).action, 'busy');
  // dead dashboard, now(5000) - startedAt(100) > grace(2000) → reclaim
  assert.equal(evaluateLease(ex, { ...base, probe: probeOf({}) }).action, 'reclaim');
  // dead dashboard but within grace → busy
  assert.equal(evaluateLease({ ...ex, startedAt: 4000 }, { ...base, probe: probeOf({}) }).action, 'busy');
});

test('probePid: win32 branch parses Get-Process output via injected exec', () => {
  let seenOpts = null;
  const exec = (cmd, args, opts) => {
    // emulate: powershell -Command "(Get-Process -Id N).StartTime.Ticks"
    assert.ok(/powershell|pwsh/i.test(cmd));
    seenOpts = opts;
    return '638000000000000000\n';
  };
  const r = probePid(4242, { platform: 'win32', execFileSync: exec });
  assert.equal(r.alive, true);
  assert.ok(Number.isFinite(r.procStartedAt));
  assert.equal(seenOpts.windowsHide, true);
});

test('probePid: win32 dead pid → not alive', () => {
  const exec = () => { throw new Error('no process'); };
  assert.deepEqual(probePid(9, { platform: 'win32', execFileSync: exec }), { alive: false, procStartedAt: null });
});

test('probePid: win32 non-numeric output → alive but indeterminate (busy), never falsely dead', () => {
  // A live process whose StartTime output is garbled (localized text / leaked
  // warning) must NOT be read as dead — that would let the lease be reclaimed.
  const exec = () => 'WARNING: something\r\n';
  assert.deepEqual(probePid(4242, { platform: 'win32', execFileSync: exec }), { alive: true, procStartedAt: null });
});
