// test/deploy-mesh.test.js — one-click deploy: discover → add → doctor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deployMesh } from '../src/builder/deploy.js';
import { main } from '../src/cli.js';
import { CURRENT_MESH_VERSION } from '../src/builder/conformance.js';

async function runCli(argv) {
  const orig = process.stdout.write.bind(process.stdout);
  let out = '';
  process.stdout.write = (s) => { out += s; return true; };
  try { await main(argv, {}); } finally { process.stdout.write = orig; }
  return out;
}

// A minimally-conformant agent folder under `parent/<name>`.
async function makeAgent(parent, name) {
  const dir = join(parent, name);
  await mkdir(join(dir, 'prompts'), { recursive: true });
  await writeFile(join(dir, 'agent.json'), JSON.stringify({
    name, protocolVersion: '1.0', version: '0.1.0', skills: [],
    'x-agentmesh': { modes: ['ask'], meshVersion: CURRENT_MESH_VERSION },
  }));
  await writeFile(join(dir, 'prompts', 'system.md'), `you are ${name}`);
  return dir;
}

async function scanRootWith(...names) {
  const scan = await mkdtemp(join(tmpdir(), 'deploy-scan-'));
  for (const n of names) await makeAgent(scan, n);
  return scan;
}

test('dry-run on a fresh mesh plans init + adds but writes nothing', async () => {
  const scan = await scanRootWith('alpha', 'beta');
  const mesh = join(await mkdtemp(join(tmpdir(), 'deploy-mesh-')), 'newmesh');
  const r = await deployMesh(scan, { meshRoot: mesh });
  assert.equal(r.dryRun, true);
  assert.equal(r.initialized, 'would-init');
  assert.deepEqual(r.added.map((a) => a.name).sort(), ['alpha', 'beta']);
  assert.ok(r.added.every((a) => a.planned));
  assert.equal(existsSync(join(mesh, 'mesh.json')), false, 'dry-run must not create the mesh');
});

test('apply on a fresh mesh initializes, adds agents, and runs doctor', async () => {
  const scan = await scanRootWith('alpha', 'beta');
  const mesh = join(await mkdtemp(join(tmpdir(), 'deploy-mesh-')), 'newmesh');
  const r = await deployMesh(scan, { meshRoot: mesh, apply: true });
  assert.equal(r.initialized, true);
  assert.equal(existsSync(join(mesh, 'mesh.json')), true);
  const manifest = JSON.parse(await readFile(join(mesh, 'mesh.json'), 'utf8'));
  assert.deepEqual(manifest.agents.map((a) => a.name).sort(), ['alpha', 'beta']);
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  assert.ok(r.doctor, 'doctor ran after adds');
});

test('re-running apply is idempotent — already-in-mesh agents are skipped', async () => {
  const scan = await scanRootWith('alpha');
  const mesh = join(await mkdtemp(join(tmpdir(), 'deploy-mesh-')), 'newmesh');
  await deployMesh(scan, { meshRoot: mesh, apply: true });
  const r2 = await deployMesh(scan, { meshRoot: mesh, apply: true });
  assert.deepEqual(r2.alreadyInMesh, ['alpha']);
  assert.deepEqual(r2.added, []);
  const manifest = JSON.parse(await readFile(join(mesh, 'mesh.json'), 'utf8'));
  assert.equal(manifest.agents.filter((a) => a.name === 'alpha').length, 1, 'no duplicate entry');
});

test('a candidate physically under the mesh root is reported for join, not copied', async () => {
  const scan = await mkdtemp(join(tmpdir(), 'deploy-intree-'));
  // mesh root is the scan root; an agent folder lives inside it.
  await makeAgent(scan, 'inside');
  const r = await deployMesh(scan, { meshRoot: scan, apply: true });
  assert.deepEqual(r.skippedInTree.map((s) => s.name), ['inside']);
  assert.deepEqual(r.added, []);
});

test('CLI `deploy` requires --mesh and dry-runs by default', async () => {
  const scan = await scanRootWith('gamma');
  const mesh = join(await mkdtemp(join(tmpdir(), 'deploy-cli-')), 'm');

  // missing --mesh → nonzero exit
  const origExit = process.exitCode; process.exitCode = undefined;
  const origErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  try { await main(['deploy', scan], {}); } finally { process.stderr.write = origErr; }
  const noMeshCode = process.exitCode; process.exitCode = origExit;
  assert.ok(noMeshCode !== undefined && noMeshCode !== 0);

  // dry-run plans without writing
  const out = await runCli(['deploy', scan, '--mesh', mesh]);
  assert.match(out, /\[dry-run\]/);
  assert.match(out, /Would initialize a new mesh/);
  assert.match(out, /Would add 1 agent/);
  assert.match(out, /gamma/);
  assert.equal(existsSync(join(mesh, 'mesh.json')), false);
});
