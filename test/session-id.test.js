// test/session-id.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveSessionId, readEpoch, persistEpoch } from '../src/a2a/session-id.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test('deriveSessionId is a deterministic v5 UUID, namespaced by encoded root', () => {
  const a = deriveSessionId('B:0', 'C--AI-mesh-catalog');
  const b = deriveSessionId('B:0', 'C--AI-mesh-catalog');
  const other = deriveSessionId('B:0', 'C--AI-mesh-library');
  const reset = deriveSessionId('B:1', 'C--AI-mesh-catalog');
  assert.match(a, UUID_RE);
  assert.equal(a, b);                 // deterministic
  assert.notEqual(a, other);          // different peer (namespace) → different id
  assert.notEqual(a, reset);          // different epoch → different id
});

test('epoch store is per-caller, persistent, atomic, and tolerant', async () => {
  const root = await mkdtemp(join(tmpdir(), 'epoch-'));
  try {
    assert.equal(await readEpoch(root, 'B'), 0);          // default 0
    await persistEpoch(root, 'B', 1);
    assert.equal(await readEpoch(root, 'B'), 1);          // persisted
    assert.equal(await readEpoch(root, 'D'), 0);          // per-caller isolation
    await persistEpoch(root, 'D', 5);
    assert.equal(await readEpoch(root, 'B'), 1);          // B unaffected by D
    assert.equal(await readEpoch(root, 'B/../x'), 0);     // odd caller never escapes/crashes
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
