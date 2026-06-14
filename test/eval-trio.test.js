// test/eval-trio.test.js — the reusable eval trio (examples/eval-trio + setup
// script) covering peer-selection + two-hop. Hermetic: validates the source
// folders, then materializes the trio and asserts the framework wired a marked,
// stdio-A2A mesh with the right peering on BOTH app and docs. No `claude`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { doctor } from '../src/builder/doctor.js';

const repoRoot = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
const srcTrio = join(repoRoot, 'examples', 'eval-trio');
const setup = join(repoRoot, 'scripts', 'eval-trio-setup.mjs');

test('eval-trio source folders are well-formed', () => {
  for (const name of ['app', 'lib', 'docs']) {
    const card = JSON.parse(readFileSync(join(srcTrio, name, 'agent.json'), 'utf8'));
    assert.equal(card.name, name);
    assert.deepEqual(card['x-agentmesh'].modes, ['ask', 'do']);
    assert.ok(existsSync(join(srcTrio, name, 'AGENT.md')), `${name}/AGENT.md present`);
  }
  // lib owns the canonical data; docs owns prose but NOT shelf codes.
  assert.match(readFileSync(join(srcTrio, 'lib', 'data', 'shelf-codes.md'), 'utf8'), /DUNE-7F/);
  assert.ok(existsSync(join(srcTrio, 'docs', 'templates', 'release-note.md')));
});

test('setup wires peer-selection + two-hop topology over stdio A2A', async () => {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'eval-trio-test-')));
  try {
    execFileSync(process.execPath, [setup, ws, '--force'], { stdio: 'pipe' });

    // manifest: app routes to both peers; docs onward-routes to lib.
    const manifest = JSON.parse(readFileSync(join(ws, 'mesh.json'), 'utf8'));
    const byName = (n) => manifest.agents.find((a) => a.name === n);
    assert.deepEqual(byName('app').peers.sort(), ['docs', 'lib']);
    assert.deepEqual(byName('docs').peers, ['lib']);
    assert.deepEqual(byName('lib').peers, []);

    // Both app and docs get a marked registry whose peer transport is serve-a2a.
    for (const [agent, expectPeers] of [['app', ['docs', 'lib']], ['docs', ['lib']]]) {
      const reg = JSON.parse(readFileSync(join(ws, agent, 'registry.json'), 'utf8'));
      assert.equal(reg['x-agentmesh-generated'], true, `${agent} registry marked`);
      assert.deepEqual(Object.keys(reg.peers).sort(), expectPeers, `${agent} peers`);
      for (const p of Object.keys(reg.peers)) {
        assert.ok(reg.peers[p].args.includes('serve-a2a'), `${agent}->${p} is stdio serve-a2a`);
      }
      const mcp = JSON.parse(readFileSync(join(ws, agent, '.mcp.json'), 'utf8'));
      assert.ok(mcp.mcpServers.agentmesh_peerbridge, `${agent} peer-bridge wired`);
    }
    // lib is a leaf — marked registry with empty peers, and no peer-bridge.
    const libReg = JSON.parse(readFileSync(join(ws, 'lib', 'registry.json'), 'utf8'));
    assert.deepEqual(libReg.peers, {}, 'lib leaf has no peers');
    assert.equal(existsSync(join(ws, 'lib', '.mcp.json')), false, 'lib leaf has no peer-bridge');

    // Idempotent: a second doctor --apply leaves the wiring unflagged.
    const report = await doctor(ws, { apply: true });
    assert.ok(!report.flagged.some((f) => /registry|peer/i.test(f)), `no wiring flags: ${report.flagged.join('; ')}`);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
