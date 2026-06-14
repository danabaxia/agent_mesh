import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionPaths, readSessionId, writeSessionId } from '../src/dashboard/session-store.js';

test('sessionPaths live under the runtime temp state dir', () => {
  const p = sessionPaths('/tmp/mesh', '/tmp/mesh');   // agentRoot == meshRoot (manifest root ".")
  assert.ok(p.dir.startsWith(join(tmpdir(), 'agent-mesh', 'sessions')));
  assert.ok(p.jsonPath.endsWith('.json'));
  assert.ok(p.lockPath.endsWith('.lock'));
});

test('write then read round-trips the canonical id', async () => {
  const mesh = '/tmp/mesh-' + Math.random().toString(16).slice(2);
  const agent = mesh + '/alpha';
  assert.equal(await readSessionId(mesh, agent), null);
  await writeSessionId(mesh, agent, 'SESSION-XYZ');
  assert.equal(await readSessionId(mesh, agent), 'SESSION-XYZ');
});
