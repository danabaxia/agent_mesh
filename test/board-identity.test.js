import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { resolveMeshRoot, resolveSelfName } from '../src/board/identity.js';

test('resolveMeshRoot prefers CEILING, then dirname(MESH_ROOT), else null', () => {
  assert.equal(resolveMeshRoot({ AGENT_MESH_MESH_CEILING: '/m' }), '/m');
  assert.equal(resolveMeshRoot({ AGENT_MESH_MESH_ROOT: '/m/mesh' }), '/m');
  assert.equal(resolveMeshRoot({}), null);
});

test('resolveSelfName matches the agent whose manifest root realpaths to root', async () => {
  const mesh = await mkdtemp(join(tmpdir(), 'board-id-'));
  const agentRoot = join(mesh, 'agentB');
  await mkdir(agentRoot, { recursive: true });
  await writeFile(join(mesh, 'mesh.json'), JSON.stringify({
    'x-agentmesh-generated': true, meshVersion: 1,
    agents: [{ name: 'agentB', root: 'agentB' }, { name: 'agentA', root: 'agentA' }]
  }), 'utf8');
  const name = await resolveSelfName({ root: await realpath(agentRoot), env: { AGENT_MESH_MESH_CEILING: mesh } });
  assert.equal(name, 'agentB');
});

test('resolveSelfName returns null when no manifest agent matches', async () => {
  const mesh = await mkdtemp(join(tmpdir(), 'board-id-'));
  await writeFile(join(mesh, 'mesh.json'), JSON.stringify({ agents: [] }), 'utf8');
  assert.equal(await resolveSelfName({ root: mesh, env: { AGENT_MESH_MESH_CEILING: mesh } }), null);
});
