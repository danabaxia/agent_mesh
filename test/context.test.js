import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enterCallContext, readCallContext } from '../src/context.js';

test('readCallContext reads newline path and positive depth', () => {
  assert.deepEqual(readCallContext({ AGENT_MESH_PATH: '/a\n/b', AGENT_MESH_DEPTH: '2' }), {
    path: ['/a', '/b'],
    depth: 2
  });
});

test('enterCallContext appends root and decrements depth', () => {
  const entered = enterCallContext('/c', { AGENT_MESH_PATH: '/a\n/b', AGENT_MESH_DEPTH: '2' });
  assert.equal(entered.ok, true);
  assert.equal(entered.env.AGENT_MESH_PATH, '/a\n/b\n/c');
  assert.equal(entered.env.AGENT_MESH_DEPTH, '1');
});

test('enterCallContext refuses cycles and exhausted budget', () => {
  assert.equal(enterCallContext('/b', { AGENT_MESH_PATH: '/a\n/b', AGENT_MESH_DEPTH: '2' }).result.error.code, 'cycle');
  assert.equal(enterCallContext('/c', { AGENT_MESH_DEPTH: '0' }).result.error.code, 'depth_budget');
});

test('enterCallContext treats an invalid (negative) depth as the default budget, not exhaustion', () => {
  // readDepth rejects values < 0 and falls back to DEFAULT_DEPTH (3); proceeding
  // then decrements to 2. This pins the fallback, not just `.ok`.
  const entered = enterCallContext('/c', { AGENT_MESH_DEPTH: '-1' });
  assert.equal(entered.ok, true);
  assert.equal(entered.context.depth, 2);
});

// Identity is the realpath-canonical folder path: two symlinked aliases of the
// same folder must collapse to one identity so an alias cannot evade the cycle
// guard. enterCallContext is a pure function over already-canonical inputs (the
// impure shell canonicalizes via realpath in cli.js/registry.js); this asserts
// the contract those callers rely on.
test('enterCallContext treats a realpath-canonicalized symlink alias as the same identity (cycle)', async () => {
  const real = await mkdtemp(join(tmpdir(), 'agent-mesh-ctx-'));
  await mkdir(join(real, 'folder'));
  const aliasDir = await mkdtemp(join(tmpdir(), 'agent-mesh-ctx-alias-'));
  const alias = join(aliasDir, 'link');
  await symlink(join(real, 'folder'), alias);

  const canonicalReal = await realpath(join(real, 'folder'));
  const canonicalAlias = await realpath(alias);
  assert.equal(canonicalAlias, canonicalReal, 'aliases must canonicalize to one path');

  const entered = enterCallContext(canonicalAlias, { AGENT_MESH_PATH: canonicalReal, AGENT_MESH_DEPTH: '3' });
  assert.equal(entered.ok, false);
  assert.equal(entered.result.error.code, 'cycle');
});
