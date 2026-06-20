import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAutomergeEnabled } from '../src/automerge/enabled.js';

test('env AUTOMERGE_ENABLED=true wins immediately (no repo-var read)', async () => {
  let read = false;
  const r = await resolveAutomergeEnabled({ env: { AUTOMERGE_ENABLED: 'true' }, readVar: async () => { read = true; return 'false'; } });
  assert.equal(r, true);
  assert.equal(read, false, 'must not read the repo var when env already opts in');
});

test('falls back to the repo variable when env is unset (the daemon case)', async () => {
  assert.equal(await resolveAutomergeEnabled({ env: {}, readVar: async () => 'true' }), true);
  assert.equal(await resolveAutomergeEnabled({ env: {}, readVar: async () => 'false' }), false);
  assert.equal(await resolveAutomergeEnabled({ env: {}, readVar: async () => '  true\n' }), true, 'trims whitespace');
});

test('repo-var read error / no resolver → disabled (safe default)', async () => {
  assert.equal(await resolveAutomergeEnabled({ env: {}, readVar: async () => { throw new Error('no access'); } }), false);
  assert.equal(await resolveAutomergeEnabled({ env: {} }), false);
});
