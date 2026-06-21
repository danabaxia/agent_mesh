import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoSync } from '../src/dashboard/auto-sync.js';

// Controllable schedule seam: capture the pending timer fn; fire() runs it.
function fakeSchedule() {
  let pending = null;
  const schedule = (fn) => { pending = fn; return { id: 1 }; };
  const clearSchedule = () => { pending = null; };
  return { schedule, clearSchedule, fire: async () => { const fn = pending; pending = null; if (fn) await fn(); }, get armed() { return pending !== null; } };
}

test('debounce: many triggers collapse to ONE run', async () => {
  const t = fakeSchedule();
  const calls = [];
  const mgr = createAutoSync({ runSync: async () => { calls.push(1); return { fixed: ['x'] }; },
    schedule: t.schedule, clearSchedule: t.clearSchedule, debounceMs: 5, onResult: () => {}, log: () => {} });
  mgr.trigger(); mgr.trigger(); mgr.trigger();
  await t.fire();
  assert.equal(calls.length, 1);
});

test('onResult fires with the result; serialized rerun when triggered mid-run', async () => {
  const t = fakeSchedule();
  let release; const gate = new Promise((r) => { release = r; });
  const results = [];
  let n = 0;
  const mgr = createAutoSync({
    runSync: async () => { n++; if (n === 1) await gate; return { fixed: [`run${n}`] }; },
    schedule: t.schedule, clearSchedule: t.clearSchedule, debounceMs: 5,
    onResult: (r) => results.push(r), log: () => {}
  });
  mgr.trigger();
  const fired = t.fire();           // starts run 1 (awaits gate)
  mgr.trigger();                    // lands mid-run → sets pendingRerun, no new timer
  release();
  await fired;                      // run 1 completes → pendingRerun drives run 2
  assert.equal(t.armed, false);     // mid-run trigger did NOT arm a redundant timer
  assert.deepEqual(results.map((r) => r.result.fixed[0]), ['run1', 'run2']);
});

test('runNow bypasses debounce and runs immediately', async () => {
  const t = fakeSchedule();
  const calls = [];
  const mgr = createAutoSync({ runSync: async () => { calls.push(1); return { fixed: [] }; },
    schedule: t.schedule, clearSchedule: t.clearSchedule, debounceMs: 5, onResult: () => {}, log: () => {} });
  await mgr.runNow();
  assert.equal(calls.length, 1);
  assert.equal(t.armed, false); // did not use the debounce timer
});

test('runSync rejection → onResult {ok:false, error}; never throws', async () => {
  const t = fakeSchedule();
  const results = [];
  const mgr = createAutoSync({ runSync: async () => { throw new Error('boom'); },
    schedule: t.schedule, clearSchedule: t.clearSchedule, debounceMs: 5, onResult: (r) => results.push(r), log: () => {} });
  await mgr.runNow();
  assert.equal(results[0].ok, false);
  assert.match(results[0].error.message, /boom/);
});

test('stop cancels a pending fire', async () => {
  const t = fakeSchedule();
  const calls = [];
  const mgr = createAutoSync({ runSync: async () => { calls.push(1); return { fixed: [] }; },
    schedule: t.schedule, clearSchedule: t.clearSchedule, debounceMs: 5, onResult: () => {}, log: () => {} });
  mgr.trigger();
  mgr.stop();
  await t.fire(); // the captured fn should no-op after stop
  assert.equal(calls.length, 0);
});

test('stop() awaits an in-flight runSync (drains the startup run before resolving)', async () => {
  // Root cause of the Windows ci-schedules-route.test.js flake: start() fires
  // autoSync.runNow() fire-and-forget; if close() does not await the in-flight
  // doctor write, it lands AFTER the test's rmSync → ENOTEMPTY. stop() must drain it.
  const t = fakeSchedule();
  let released = false;
  let release; const gate = new Promise((r) => { release = r; });
  const mgr = createAutoSync({
    runSync: async () => { await gate; released = true; return { fixed: [] }; },
    schedule: t.schedule, clearSchedule: t.clearSchedule, debounceMs: 5, onResult: () => {}, log: () => {}
  });
  const running = mgr.runNow();          // starts the run, blocks on gate
  const stopP = mgr.stop();              // must await the in-flight run
  let stopResolved = false;
  stopP.then(() => { stopResolved = true; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(stopResolved, false, 'stop() must not resolve while runSync is in flight');
  release();                            // let the in-flight run finish
  await stopP;
  assert.equal(released, true, 'in-flight runSync completed before stop() resolved');
  await running;
});
