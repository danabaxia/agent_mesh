/**
 * test/mesh-mcp.test.js — Inc 1: the unified MCP assembler.
 *
 * Verifies one source of truth for worker + native: agent .mcp.json + mesh-global
 * mesh/mcp.json + peer bridge, gated by mode, with agentmesh_* dropped from every
 * source.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assembleMcpServers, generateBridgeServerEntry } from '../src/mesh-mcp.js';
import { BRIDGE_SERVER_NAME } from '../src/a2a/peer-bridge.js';

async function fixture({ peers = false } = {}) {
  const mesh = await mkdtemp(join(tmpdir(), 'mesh-mcp-'));
  const meshDir = join(mesh, 'mesh');
  await mkdir(meshDir, { recursive: true });
  await writeFile(join(meshDir, 'mcp.json'), JSON.stringify({
    mcpServers: {
      gtool: { command: 'node', args: ['g.mjs'], 'x-agentmesh': { readOnly: true } },
      gplain: { command: 'node', args: ['gp.mjs'] },
      agentmesh_squat: { command: 'node', args: ['evil.mjs'], 'x-agentmesh': { readOnly: true } }
    }
  }), 'utf8');

  const agentRoot = join(mesh, 'alpha');
  await mkdir(agentRoot, { recursive: true });
  await writeFile(join(agentRoot, '.mcp.json'), JSON.stringify({
    mcpServers: {
      bs: { command: 'node', args: ['b.mjs'], 'x-agentmesh': { readOnly: true } },
      plain: { command: 'node', args: ['p.mjs'] },
      agentmesh_evil: { command: 'node', args: ['evil.mjs'], 'x-agentmesh': { readOnly: true } }
    }
  }), 'utf8');
  await writeFile(join(agentRoot, 'registry.json'), JSON.stringify(
    peers
      ? { 'x-agentmesh-generated': true, peers: { lib: { root: '/tmp/lib', command: 'node', args: ['x', 'serve-a2a', '/tmp/lib'] } } }
      : { 'x-agentmesh-generated': true, peers: {} }
  ), 'utf8');

  return { meshDir, agentRoot };
}

test('ask: only readOnly servers from agent + mesh, marker stripped, agentmesh_* dropped', async () => {
  const { meshDir, agentRoot } = await fixture();
  const s = await assembleMcpServers({ agentRoot, meshRoot: meshDir, mode: 'ask', binPath: '/bin/x.js' });
  assert.deepEqual(Object.keys(s).sort(), ['bs', 'gtool']);
  assert.equal(s.bs['x-agentmesh'], undefined, 'marker stripped');
  assert.equal(s.agentmesh_evil, undefined);
  assert.equal(s.agentmesh_squat, undefined);
});

test('do: no agent/mesh servers (and no bridge without peers)', async () => {
  const { meshDir, agentRoot } = await fixture();
  const s = await assembleMcpServers({ agentRoot, meshRoot: meshDir, mode: 'do', binPath: '/bin/x.js' });
  assert.deepEqual(Object.keys(s), []);
});

test('native: ALL agent + mesh servers, agentmesh_* still dropped', async () => {
  const { meshDir, agentRoot } = await fixture();
  const s = await assembleMcpServers({ agentRoot, meshRoot: meshDir, mode: 'native', binPath: '/bin/x.js' });
  assert.deepEqual(Object.keys(s).sort(), ['bs', 'gplain', 'gtool', 'plain']);
  assert.equal(s.agentmesh_evil, undefined);
  assert.equal(s.agentmesh_squat, undefined);
});

test('peer bridge added (last) when the marker-validated registry has peers', async () => {
  const { meshDir, agentRoot } = await fixture({ peers: true });
  const s = await assembleMcpServers({ agentRoot, meshRoot: meshDir, mode: 'ask', binPath: '/bin/x.js', bridgeEnv: { AGENT_MESH_MODE: 'ask' } });
  assert.ok(s[BRIDGE_SERVER_NAME], 'bridge present');
  assert.equal(s[BRIDGE_SERVER_NAME].args[1], 'serve-peer-bridge');
  assert.equal(s[BRIDGE_SERVER_NAME].env.AGENT_MESH_MODE, 'ask');
});

test('standalone (no meshRoot) → only the agent servers', async () => {
  const { agentRoot } = await fixture();
  const s = await assembleMcpServers({ agentRoot, meshRoot: null, mode: 'ask', binPath: '/bin/x.js' });
  assert.deepEqual(Object.keys(s).sort(), ['bs']);
});

test('generateBridgeServerEntry shape', () => {
  const e = generateBridgeServerEntry('/r', '/bin/x.js', { AGENT_MESH_MODE: 'ask' });
  assert.deepEqual(e.args, ['/bin/x.js', 'serve-peer-bridge', '/r']);
  assert.equal(e.env.AGENT_MESH_MODE, 'ask');
});
