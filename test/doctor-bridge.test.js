// test/doctor-bridge.test.js — doctor syncs the peer-bridge MCP entry into each
// peered agent's .mcp.json so ANY claude session started in the agent folder
// (not just dashboard/worker launches, which assemble their own config) can
// reach its peers. Reserved agentmesh_* names are dropped by the framework's
// own config assembly, so the persisted entry never duplicates the bridge in
// worker / CLI-button sessions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctor } from '../src/builder/doctor.js';
import { initMesh } from '../src/builder/init-mesh.js';
import { writeManifest } from '../src/builder/manifest.js';
import { CANONICAL_DIRS } from '../src/builder/scaffold.js';

const agentJson = (name) => JSON.stringify({
  name, protocolVersion: '1.0', version: '0.1.0', skills: [],
  'x-agentmesh': { modes: ['ask'], meshVersion: '0.1.0' }
}) + '\n';

async function buildMesh({ peers = ['b'], authoredMcp = null } = {}) {
  const meshRoot = await mkdtemp(join(tmpdir(), 'docbridge-'));
  await initMesh(meshRoot);
  for (const name of ['a', 'b']) {
    const root = join(meshRoot, name);
    await mkdir(join(root, 'prompts'), { recursive: true });
    await writeFile(join(root, 'agent.json'), agentJson(name), 'utf8');
    await writeFile(join(root, 'prompts', 'system.md'), `# ${name}\n`, 'utf8');
    for (const d of CANONICAL_DIRS) await mkdir(join(root, d), { recursive: true });
  }
  if (authoredMcp) {
    await writeFile(join(meshRoot, 'a', '.mcp.json'), JSON.stringify(authoredMcp, null, 2) + '\n', 'utf8');
  }
  await writeManifest(meshRoot, {
    meshVersion: '0.1.0',
    agents: [
      { name: 'a', root: './a', card: 'agent.json', served: true, enabledModes: ['ask'], peers },
      { name: 'b', root: './b', card: 'agent.json', served: true, enabledModes: ['ask'], peers: [] }
    ]
  });
  return meshRoot;
}

const readMcp = async (meshRoot, name) =>
  JSON.parse(await readFile(join(meshRoot, name, '.mcp.json'), 'utf8'));

test('doctor --apply creates .mcp.json with the peer-bridge entry for a peered agent', async () => {
  const meshRoot = await buildMesh();
  await doctor(meshRoot, { apply: true });
  const mcp = await readMcp(meshRoot, 'a');
  const entry = mcp.mcpServers.agentmesh_peerbridge;
  assert.ok(entry, 'bridge entry present');
  assert.equal(entry.command, 'node');
  assert.equal(entry.args[1], 'serve-peer-bridge');
  // doctor derives agent roots from realpath(meshRoot) (conformance.js
  // meshRootCanonical), so on Windows — where os.tmpdir() yields an 8.3 SHORT path
  // that realpath expands to the LONG form — the written path is the canonical
  // LONG one. Canonicalize the EXPECTED side too so the comparison matches what
  // doctor wrote rather than the raw mkdtemp path. No-op on Linux.
  const canonRoot = await realpath(meshRoot);
  assert.equal(entry.args[2], join(canonRoot, 'a'));
});

test('doctor --apply MERGES into an authored .mcp.json, preserving existing servers', async () => {
  const meshRoot = await buildMesh({
    authoredMcp: { mcpServers: { 'tester-control': { type: 'stdio', command: 'python', args: ['C:/x/server.py'] } } }
  });
  await doctor(meshRoot, { apply: true });
  const mcp = await readMcp(meshRoot, 'a');
  assert.ok(mcp.mcpServers['tester-control'], 'authored server preserved');
  assert.equal(mcp.mcpServers['tester-control'].command, 'python');
  assert.ok(mcp.mcpServers.agentmesh_peerbridge, 'bridge merged in');
});

test('peerless agent: no .mcp.json created; a stale bridge entry is removed', async () => {
  const meshRoot = await buildMesh();
  // plant a stale bridge entry on the PEERLESS agent b
  await writeFile(join(meshRoot, 'b', '.mcp.json'), JSON.stringify({
    mcpServers: {
      agentmesh_peerbridge: { command: 'node', args: ['old', 'serve-peer-bridge', 'old'] },
      keepme: { type: 'stdio', command: 'python', args: ['C:/keep.py'] }
    }
  }) + '\n', 'utf8');
  await doctor(meshRoot, { apply: true });
  const mcpB = await readMcp(meshRoot, 'b');
  assert.ok(!mcpB.mcpServers.agentmesh_peerbridge, 'stale bridge removed from peerless agent');
  assert.ok(mcpB.mcpServers.keepme, 'other servers untouched');
});

test('dry-run reports the sync but writes nothing', async () => {
  const meshRoot = await buildMesh();
  const report = await doctor(meshRoot, { apply: false });
  assert.ok([...report.fixed, ...report.seeded].some((s) => /peer-bridge|\.mcp\.json/i.test(s)),
    `expected a bridge-sync line, got: ${JSON.stringify(report)}`);
  await assert.rejects(() => stat(join(meshRoot, 'a', '.mcp.json')), 'no file written in dry-run');
});

test('idempotent: second apply changes nothing', async () => {
  const meshRoot = await buildMesh();
  await doctor(meshRoot, { apply: true });
  const before = await readFile(join(meshRoot, 'a', '.mcp.json'), 'utf8');
  await doctor(meshRoot, { apply: true });
  const after = await readFile(join(meshRoot, 'a', '.mcp.json'), 'utf8');
  assert.equal(after, before);
});
