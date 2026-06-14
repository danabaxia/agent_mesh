import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSseHub } from '../src/dashboard/server.js';

// A fake SSE client res that records written frames.
function fakeRes() { const frames = []; return { writeHead() {}, write(s) { frames.push(s); return true; }, end() {}, frames }; }
function fakeReq() { const handlers = {}; return { on(ev, fn) { handlers[ev] = fn; }, _fire(ev) { handlers[ev]?.(); } }; }

test('emitSync writes a `sync` event frame to connected clients', async () => {
  const meshRoot = await mkdtemp(join(tmpdir(), 'sse-'));   // real empty dir → watcher scan harmless
  const hub = createSseHub({ meshRoot, pollMs: 100000, onMeshChange: () => {} });
  const res = fakeRes();
  await hub.addClient(fakeReq(), res);
  hub.emitSync({ synced: ['coder'], at: 123 });
  const frame = res.frames.find((f) => f.startsWith('event: sync'));
  assert.ok(frame, 'a sync frame was written');
  assert.match(frame, /"synced":\["coder"\]/);
  hub.close();
});

test('onMeshChange is invoked when the watcher reports a change', async () => {
  const meshRoot = await mkdtemp(join(tmpdir(), 'sse-'));
  let hits = 0;
  const hub = createSseHub({ meshRoot, pollMs: 100000, onMeshChange: () => { hits++; } });
  // Expose onWatcherChange in return so the test can fire a simulated change
  // hermetically without relying on real fs events.
  const res = fakeRes();
  await hub.addClient(fakeReq(), res);
  // Fire a simulated watcher change via the exposed handle
  await hub.onWatcherChange({ kind: 'change', scopes: ['mesh'] });
  hub.close();
  assert.equal(hits, 1); // onMeshChange was called once by the simulated change
});
