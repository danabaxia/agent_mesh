import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pidfilePath, reapExisting, writePidfile, removePidfile } from '../src/dashboard/single-instance.js';

test('pidfilePath is port-scoped + deterministic', () => {
  assert.match(pidfilePath(7077, '/tmp'), /\/tmp\/agent-mesh-dashboard-7077\.pid$/);
  assert.notEqual(pidfilePath(7077, '/tmp'), pidfilePath(9000, '/tmp'));
});

// A fake process table + kill. table[pid] ∈ 'alive' | 'ignores-sigterm' | 'dead'.
function fakeKill(table) {
  return (pid, sig) => {
    const st = table[pid];
    if (sig === 0) { if (!st || st === 'dead') { const e = new Error('ESRCH'); e.code = 'ESRCH'; throw e; } return; }
    if (sig === 'SIGTERM') { if (st === 'alive') table[pid] = 'dead'; return; }   // 'ignores-sigterm' survives
    if (sig === 'SIGKILL') { table[pid] = 'dead'; return; }
  };
}
const noSleep = async () => {};
const recorder = (table) => { const calls = []; const k = fakeKill(table); return { calls, signalKill: (pid, sig) => { calls.push(sig); return k(pid, sig); } }; };

test('reapExisting: no/unreadable pidfile → none', async () => {
  const r = await reapExisting({ pidfile: '/nope.pid', readFileSync: () => { const e = new Error('ENOENT'); throw e; }, sleep: noSleep });
  assert.equal(r.action, 'none');
});

test('reapExisting: stale (dead) pid → stale, no SIGTERM', async () => {
  const { calls, signalKill } = recorder({ 111: 'dead' });
  const r = await reapExisting({ pidfile: 'x', readFileSync: () => JSON.stringify({ pid: 111 }), signalKill, sleep: noSleep });
  assert.equal(r.action, 'stale');
  assert.ok(!calls.includes('SIGTERM') && !calls.includes('SIGKILL'));
});

test('reapExisting: live pid that exits on SIGTERM → reaped, no SIGKILL', async () => {
  const { calls, signalKill } = recorder({ 222: 'alive' });
  const r = await reapExisting({ pidfile: 'x', readFileSync: () => JSON.stringify({ pid: 222 }), signalKill, sleep: noSleep, graceMs: 300, pollMs: 100 });
  assert.equal(r.action, 'reaped');
  assert.ok(calls.includes('SIGTERM'));
  assert.ok(!calls.includes('SIGKILL'));
});

test('reapExisting: live pid that ignores SIGTERM → SIGKILL after grace', async () => {
  const { calls, signalKill } = recorder({ 333: 'ignores-sigterm' });
  const r = await reapExisting({ pidfile: 'x', readFileSync: () => JSON.stringify({ pid: 333 }), signalKill, sleep: noSleep, graceMs: 300, pollMs: 100 });
  assert.equal(r.action, 'reaped');
  assert.ok(calls.includes('SIGTERM') && calls.includes('SIGKILL'));
});

test('reapExisting: --no-replace + live pid → throws refusal', async () => {
  const { signalKill } = recorder({ 444: 'alive' });
  await assert.rejects(
    reapExisting({ pidfile: 'x', replace: false, readFileSync: () => JSON.stringify({ pid: 444 }), signalKill, sleep: noSleep }),
    /already running/,
  );
});

test('writePidfile/removePidfile: round-trip + best-effort (never throw)', () => {
  let written = null;
  writePidfile('p', { pid: 5, port: 7077, now: 123 }, { writeFileSync: (f, c) => { written = c; } });
  assert.deepEqual(JSON.parse(written), { pid: 5, port: 7077, startedAt: 123 });
  assert.doesNotThrow(() => writePidfile('p', { pid: 5, port: 7077, now: 1 }, { writeFileSync: () => { throw new Error('EACCES'); } }));
  assert.doesNotThrow(() => removePidfile('p', { rmSync: () => { throw new Error('boom'); } }));
});
