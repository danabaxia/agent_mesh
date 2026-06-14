import test from 'node:test';
import assert from 'node:assert/strict';
import { createRotationManager } from '../src/dashboard/rotation.js';

const USAGE_LOW = { input_tokens: 160_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }; // 20% headroom
const USAGE_HIGH = { input_tokens: 50_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }; // 75% headroom

function harness({ digestResult = { status: 'done', applied: {} }, env = {}, readSessionId = null } = {}) {
  const fired = [];   // captured idle timers
  const calls = { digest: [], writes: [], events: [], busyOnce: false };
  // Track the last armed sessionId so the default readSessionId stub can return
  // it (making existing tests pass — rotation should succeed when id is unchanged).
  const state = { lastArmedSid: null };
  const mgr = createRotationManager({
    meshRoot: '/mesh',
    runMaintenance: async (agentName, fn) => {
      if (calls.busyOnce) { calls.busyOnce = false; const e = new Error('busy'); e.code = 'session_busy'; throw e; }
      return fn({ agentRoot: `/mesh/${agentName}` });
    },
    runDigest: async (args) => { calls.digest.push(args); return digestResult; },
    writeSessionId: async (meshRoot, agentRoot, id) => { calls.writes.push({ agentRoot, id }); },
    readSessionId: readSessionId ?? (async () => state.lastArmedSid),
    recordEvent: async (meshRoot, ev) => { calls.events.push(ev); },
    env: { AGENT_MESH_ROTATE_IDLE_MS: '1', ...env },
    schedule: (fn) => { fired.push(fn); return { unref() {} }; },
    clearSchedule: () => {},
    log: () => {}
  });
  // Wrap onTurnComplete to record the last armed sessionId for the default stub.
  const origOnTurnComplete = mgr.onTurnComplete;
  mgr.onTurnComplete = (info) => { if (info?.sessionId) state.lastArmedSid = info.sessionId; return origOnTurnComplete(info); };
  return { mgr, fired, calls, async fire() { const fn = fired.pop(); await fn(); } };
}

test('below threshold arms; firing digests then rotates with provenance', async () => {
  const h = harness();
  h.mgr.onTurnComplete({ agentName: 'a', agentRoot: '/mesh/a', sessionId: 'old-id', usage: USAGE_LOW });
  assert.equal(h.fired.length, 1);
  await h.fire();
  assert.equal(h.calls.digest[0].sessionId, 'old-id');
  assert.equal(h.calls.writes.length, 1);
  assert.notEqual(h.calls.writes[0].id, 'old-id');
  const ev = h.calls.events[0];
  assert.equal(ev.kind, 'rotate');
  assert.equal(ev.source, 'headroom');
  assert.equal(ev.priorSessionId, 'old-id');
  assert.equal(ev.sessionId, h.calls.writes[0].id);
});

test('digest failure → no rotation, error retained; healthy turn above threshold cancels pending', async () => {
  const h = harness({ digestResult: { status: 'error', error: { code: 'digest_contract_invalid' } } });
  h.mgr.onTurnComplete({ agentName: 'a', agentRoot: '/mesh/a', sessionId: 's', usage: USAGE_LOW });
  await h.fire();
  assert.equal(h.calls.writes.length, 0);
  assert.equal(h.mgr.lastErrorFor('a'), 'digest_contract_invalid');
  h.mgr.onTurnComplete({ agentName: 'a', agentRoot: '/mesh/a', sessionId: 's', usage: USAGE_LOW });
  h.mgr.onTurnComplete({ agentName: 'a', agentRoot: '/mesh/a', sessionId: 's', usage: USAGE_HIGH });
  assert.equal(h.fired.length, 1); // stale timer still captured…
  await h.fire();                  // …but firing it is a no-op (token guard)
  assert.equal(h.calls.digest.length, 1); // still only the first run's digest
});

test('runMaintenance busy → re-arms instead of erroring; no usage or threshold 0 → never arms', async () => {
  const h = harness();
  h.calls.busyOnce = true;
  h.mgr.onTurnComplete({ agentName: 'a', agentRoot: '/mesh/a', sessionId: 's', usage: USAGE_LOW });
  await h.fire();
  assert.equal(h.fired.length, 1); // re-armed
  const off = harness({ env: { AGENT_MESH_ROTATE_HEADROOM_PCT: '0' } });
  off.mgr.onTurnComplete({ agentName: 'a', agentRoot: '/a', sessionId: 's', usage: USAGE_LOW });
  assert.equal(off.fired.length, 0);
  const noUsage = harness();
  noUsage.mgr.onTurnComplete({ agentName: 'a', agentRoot: '/a', sessionId: 's', usage: null });
  assert.equal(noUsage.fired.length, 0);
});

test('isDigesting reflects the maintenance window', async () => {
  let resolveGate; const gate = new Promise((r) => { resolveGate = r; });
  const seen = [];
  let fireFn = null;
  const mgr = createRotationManager({
    meshRoot: '/m',
    runMaintenance: async (n, fn) => fn({ agentRoot: '/m/a' }),
    runDigest: async () => { seen.push(mgr.isDigesting('a')); await gate; return { status: 'done', applied: {} }; },
    writeSessionId: async () => {}, readSessionId: async () => 's', recordEvent: async () => {},
    env: { AGENT_MESH_ROTATE_IDLE_MS: '1' },
    schedule: (fn) => { fireFn = fn; return { unref() {} }; }, clearSchedule: () => {},
    log: () => {}
  });
  mgr.onTurnComplete({ agentName: 'a', agentRoot: '/m/a', sessionId: 's', usage: USAGE_LOW });
  const p = fireFn();
  resolveGate();
  await p;
  assert.deepEqual([seen[0], mgr.isDigesting('a')], [true, false]);
});

test('rotation aborts (digest kept, no pointer write) when the canonical id moved', async () => {
  const h = harness({ readSessionId: async () => 'user-picked-other' });
  h.mgr.onTurnComplete({ agentName: 'a', agentRoot: '/mesh/a', sessionId: 'old-id', usage: USAGE_LOW });
  await h.fire();
  assert.equal(h.calls.digest.length, 1);     // digest ran (memory kept)
  assert.equal(h.calls.writes.length, 0);     // pointer untouched
  assert.equal(h.mgr.lastErrorFor('a'), 'canonical_moved');
});
