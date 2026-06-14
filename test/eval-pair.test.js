// test/eval-pair.test.js — the reusable eval pair (examples/eval-pair + the
// setup script). Hermetic: validates the source folders, then materializes the
// pair and asserts the framework wired a marked, stdio-A2A mesh. No `claude`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { doctor } from '../src/builder/doctor.js';

const repoRoot = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
const srcPair = join(repoRoot, 'examples', 'eval-pair');
const setup = join(repoRoot, 'scripts', 'eval-pair-setup.mjs');

test('eval-pair source folders are well-formed', () => {
  for (const name of ['app', 'lib']) {
    const card = JSON.parse(readFileSync(join(srcPair, name, 'agent.json'), 'utf8'));
    assert.equal(card.name, name);
    assert.deepEqual(card['x-agentmesh'].modes, ['ask', 'do']);
    assert.ok(existsSync(join(srcPair, name, 'AGENT.md')), `${name}/AGENT.md present`);
  }
  // lib owns the canonical data + writable code the eval exercises.
  assert.match(readFileSync(join(srcPair, 'lib', 'data', 'shelf-codes.md'), 'utf8'), /DUNE-7F/);
  assert.match(readFileSync(join(srcPair, 'lib', 'lib', 'strings.js'), 'utf8'), /export function slugify/);
});

test('setup script wires a marked, stdio-A2A, doctor-idempotent mesh', async () => {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'eval-pair-test-')));
  try {
    execFileSync(process.execPath, [setup, ws, '--force'], { stdio: 'pipe' });

    // manifest: both agents present, driver peered to the library.
    const manifest = JSON.parse(readFileSync(join(ws, 'mesh.json'), 'utf8'));
    const app = manifest.agents.find((a) => a.name === 'app');
    const lib = manifest.agents.find((a) => a.name === 'lib');
    assert.ok(app && lib, 'both agents in manifest');
    assert.deepEqual(app.peers, ['lib']);

    // app/registry.json: marked + the peer entry is a stdio `serve-a2a` spawn.
    const reg = JSON.parse(readFileSync(join(ws, 'app', 'registry.json'), 'utf8'));
    assert.equal(reg['x-agentmesh-generated'], true, 'registry carries the managed marker');
    assert.ok(reg.peers.lib, 'lib peer entry exists');
    assert.ok(reg.peers.lib.args.includes('serve-a2a'), 'peer transport is stdio serve-a2a');

    // app/.mcp.json: the peer-bridge stdio MCP entry doctor syncs in.
    const mcp = JSON.parse(readFileSync(join(ws, 'app', '.mcp.json'), 'utf8'));
    assert.ok(mcp.mcpServers.agentmesh_peerbridge, 'peer-bridge wired into .mcp.json');

    // Idempotent: a second doctor --apply regenerates nothing for the wiring.
    const before = readFileSync(join(ws, 'app', 'registry.json'), 'utf8');
    const report = await doctor(ws, { apply: true });
    assert.equal(readFileSync(join(ws, 'app', 'registry.json'), 'utf8'), before, 'registry stable on re-doctor');
    assert.ok(!report.flagged.some((f) => /registry|peer/i.test(f)), `no wiring flags: ${report.flagged.join('; ')}`);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
