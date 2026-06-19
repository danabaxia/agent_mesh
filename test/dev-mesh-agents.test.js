// test/dev-mesh-agents.test.js — the committed dev-mesh agent folders (Task 4).
// Hermetic: copy mesh/dev to a temp dir, run the framework's own doctor, and
// assert it generates the right stdio-A2A topology. The repo commits only agent
// CONTENT (AGENT.md/agent.json/mesh.json with relative roots); registries/.mcp.json
// are generated per-environment (machine-absolute paths), so we generate + assert
// here rather than committing them. No `claude`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { doctor } from '../src/builder/doctor.js';
import { validateManifest } from '../src/builder/manifest.js';

const repoRoot = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
const srcMesh = join(repoRoot, 'dev-mesh');

const ROLES = ['maintainer', 'analyst', 'triager', 'coder', 'tester', 'reviewer', 'curator', 'orchestrator', 'security'];

test('committed mesh.json is a valid manifest with the right roles/modes/peers', () => {
  const manifest = JSON.parse(readFileSync(join(srcMesh, 'mesh.json'), 'utf8'));
  const v = validateManifest(manifest);
  assert.equal(v.ok, true, `manifest valid: ${JSON.stringify(v.errors)}`);
  const byName = (n) => manifest.agents.find((a) => a.name === n);
  assert.deepEqual(manifest.agents.map((a) => a.name).sort(), [...ROLES].sort());
  // do roles vs ask roles
  assert.deepEqual(byName('coder').enabledModes, ['ask', 'do']);
  assert.deepEqual(byName('curator').enabledModes, ['ask', 'do']);
  assert.deepEqual(byName('security').enabledModes, ['ask']);
  assert.deepEqual(byName('tester').enabledModes, ['ask']);   // reclassified ask (spec §4.1)
  assert.deepEqual(byName('orchestrator').enabledModes, ['ask']); // ops/observability, ask-only
  assert.deepEqual(byName('orchestrator').peers, []);             // standalone: owns the gh-activity-poll builtin, no onward delegation
  // peering
  assert.deepEqual(byName('maintainer').peers.sort(), ['analyst', 'coder', 'curator', 'reviewer', 'security', 'triager']);
  assert.deepEqual(byName('coder').peers, ['tester']);
  assert.deepEqual(byName('analyst').peers, []);
  assert.deepEqual(byName('security').peers, []);
});

test('each agent folder has AGENT.md + agent.json (card name matches role)', () => {
  for (const role of ROLES) {
    assert.ok(existsSync(join(srcMesh, role, 'AGENT.md')), `${role}/AGENT.md`);
    const card = JSON.parse(readFileSync(join(srcMesh, role, 'agent.json'), 'utf8'));
    assert.equal(card.name, role);
    assert.ok(Array.isArray(card['x-agentmesh'].modes));
  }
});

test('doctor generates a marked, stdio-A2A topology from the committed content', async () => {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'dev-mesh-test-')));
  try {
    cpSync(srcMesh, ws, { recursive: true });
    await doctor(ws, { apply: true });

    // Maintainer routes to the specialists; transport is stdio serve-a2a.
    const mreg = JSON.parse(readFileSync(join(ws, 'maintainer', 'registry.json'), 'utf8'));
    assert.equal(mreg['x-agentmesh-generated'], true);
    assert.deepEqual(Object.keys(mreg.peers).sort(), ['analyst', 'coder', 'curator', 'reviewer', 'security', 'triager']);
    for (const p of Object.keys(mreg.peers)) {
      assert.ok(mreg.peers[p].args.includes('serve-a2a'), `maintainer->${p} is stdio serve-a2a`);
    }
    assert.ok(JSON.parse(readFileSync(join(ws, 'maintainer', '.mcp.json'), 'utf8')).mcpServers.agentmesh_peerbridge);

    // Coder onward-delegates to the Tester only.
    const creg = JSON.parse(readFileSync(join(ws, 'coder', 'registry.json'), 'utf8'));
    assert.deepEqual(Object.keys(creg.peers), ['tester']);
    assert.ok(JSON.parse(readFileSync(join(ws, 'coder', '.mcp.json'), 'utf8')).mcpServers.agentmesh_peerbridge);

    // A leaf (analyst) has no OUTBOUND peers, but it IS the maintainer's peer (a
    // task-board receiver), so doctor wires the peer-bridge so it can run
    // list_my_tasks / update_my_task on tasks assigned to it.
    assert.ok(JSON.parse(readFileSync(join(ws, 'analyst', '.mcp.json'), 'utf8')).mcpServers.agentmesh_peerbridge,
      'receiver leaf gets a peer-bridge for the task board');

    // Idempotent: re-doctor flags nothing about wiring.
    const report = await doctor(ws, { apply: true });
    assert.ok(!report.flagged.some((f) => /registry|peer/i.test(f)), `no wiring flags: ${report.flagged.join('; ')}`);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
