import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as shared from '../src/session-provenance.js';
import * as index from '../src/dashboard/session-index.js';

test('provenance helpers live in the shared module and round-trip', async () => {
  assert.equal(typeof shared.recordEvent, 'function');
  assert.equal(typeof shared.readEvents, 'function');
  assert.equal(typeof shared.deriveProvenance, 'function');
  const meshRoot = await mkdtemp(join(tmpdir(), 'prov-'));
  await shared.recordEvent(meshRoot, { kind: 'create', source: 'worker:digest', sessionId: 'x', agentRoot: '/a' });
  const events = await shared.readEvents(meshRoot);
  assert.equal(events.length, 1);
  assert.equal(events[0].source, 'worker:digest');
});

test('session-index re-exports are the SAME functions (back-compat)', () => {
  assert.equal(index.recordEvent, shared.recordEvent);
  assert.equal(index.readEvents, shared.readEvents);
  assert.equal(index.deriveProvenance, shared.deriveProvenance);
});
