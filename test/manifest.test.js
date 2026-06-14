import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateManifest,
  generateRegistry,
  readManifest,
  writeManifest
} from '../src/builder/manifest.js';

// ---------------------------------------------------------------------------
// validateManifest
// ---------------------------------------------------------------------------

test('validateManifest: a good manifest passes', () => {
  const manifest = {
    meshVersion: '0.1.0',
    agents: [
      {
        name: 'library',
        root: './agent-b',
        card: 'agent.json',
        served: true,
        enabledModes: ['ask'],
        peers: []
      }
    ]
  };
  const result = validateManifest(manifest);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('validateManifest: served:true + empty enabledModes fails', () => {
  const manifest = {
    meshVersion: '0.1.0',
    agents: [
      {
        name: 'alpha',
        root: './alpha',
        card: 'agent.json',
        served: true,
        enabledModes: [],
        peers: []
      }
    ]
  };
  const result = validateManifest(manifest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
  assert.ok(result.errors.some(e => /enabledModes/i.test(e)));
});

test('validateManifest: peer naming a missing agent fails', () => {
  const manifest = {
    meshVersion: '0.1.0',
    agents: [
      {
        name: 'alpha',
        root: './alpha',
        card: 'agent.json',
        served: true,
        enabledModes: ['ask'],
        peers: ['nonexistent']
      }
    ]
  };
  const result = validateManifest(manifest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => /nonexistent/i.test(e) || /missing/i.test(e)));
});

test('validateManifest: peer naming a served:false agent fails', () => {
  const manifest = {
    meshVersion: '0.1.0',
    agents: [
      {
        name: 'alpha',
        root: './alpha',
        card: 'agent.json',
        served: true,
        enabledModes: ['ask'],
        peers: ['beta']
      },
      {
        name: 'beta',
        root: './beta',
        card: 'agent.json',
        served: false,
        enabledModes: [],
        peers: []
      }
    ]
  };
  const result = validateManifest(manifest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => /beta/i.test(e) || /not.served/i.test(e) || /served/i.test(e)));
});

test('validateManifest: root with ../ fails', () => {
  const manifest = {
    meshVersion: '0.1.0',
    agents: [
      {
        name: 'escape',
        root: '../outside',
        card: 'agent.json',
        served: true,
        enabledModes: ['ask'],
        peers: []
      }
    ]
  };
  const result = validateManifest(manifest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => /root/i.test(e) || /escape/i.test(e) || /\.\./i.test(e)));
});

test('validateManifest: missing meshVersion fails', () => {
  const manifest = {
    agents: []
  };
  const result = validateManifest(manifest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => /meshVersion/i.test(e)));
});

test('validateManifest: missing agents array fails', () => {
  const manifest = {
    meshVersion: '0.1.0'
  };
  const result = validateManifest(manifest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => /agents/i.test(e)));
});

test('validateManifest: duplicate agent names fail', () => {
  const manifest = {
    meshVersion: '0.1.0',
    agents: [
      { name: 'alpha', root: './alpha', card: 'agent.json', served: true, enabledModes: ['ask'], peers: [] },
      { name: 'alpha', root: './alpha2', card: 'agent.json', served: true, enabledModes: ['ask'], peers: [] }
    ]
  };
  const result = validateManifest(manifest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => /duplicate/i.test(e) || /unique/i.test(e) || /alpha/i.test(e)));
});

test('validateManifest: absolute root fails', () => {
  const manifest = {
    meshVersion: '0.1.0',
    agents: [
      {
        name: 'abs',
        root: '/absolute/path',
        card: 'agent.json',
        served: true,
        enabledModes: ['ask'],
        peers: []
      }
    ]
  };
  const result = validateManifest(manifest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => /root/i.test(e) || /absolute/i.test(e)));
});

// ---------------------------------------------------------------------------
// generateRegistry
// ---------------------------------------------------------------------------

test('generateRegistry: agent with one peer produces correct env and paths', () => {
  const meshRootAbs = '/some/mesh';
  const binPath = '/usr/local/bin/agent-mesh.js';

  const manifest = {
    meshVersion: '0.1.0',
    agents: [
      {
        name: 'app',
        root: './app',
        card: 'agent.json',
        served: true,
        enabledModes: ['ask', 'do'],
        peers: ['catalog']
      },
      {
        name: 'catalog',
        root: './catalog',
        card: 'agent.json',
        served: true,
        enabledModes: ['ask'],
        peers: []
      }
    ]
  };

  const registry = generateRegistry(manifest, { meshRootAbs, binPath });

  // app's registry should have catalog as a peer
  const appReg = registry['app'];
  assert.ok(appReg, 'app registry must exist');
  assert.equal(appReg['x-agentmesh-generated'], true);
  assert.ok(appReg.peers, 'peers must exist');
  assert.ok(appReg.peers['catalog'], 'catalog peer must exist');

  // generateRegistry uses path.join, which yields '\\' separators on Windows;
  // normalize for the comparison (the paths are functionally correct either way).
  const s = (x) => String(x).replace(/\\/g, '/');
  const catalogPeer = appReg.peers['catalog'];
  assert.equal(s(catalogPeer.root), '/some/mesh/catalog');
  assert.equal(catalogPeer.command, 'node');
  assert.deepEqual(catalogPeer.args.map(s), [binPath, 'serve-a2a', '/some/mesh/catalog']);
  assert.equal(s(catalogPeer.cwd), '/some/mesh/catalog');
  assert.equal(catalogPeer.env.AGENT_MESH_ENABLED_MODES, 'ask');
  assert.equal(s(catalogPeer.env.AGENT_MESH_MESH_ROOT), '/some/mesh/mesh');
  assert.equal(catalogPeer.env.AGENT_MESH_MESH_CEILING, '/some/mesh');
});

test('generateRegistry: agent with no peers has empty peers map', () => {
  const meshRootAbs = '/some/mesh';
  const binPath = '/usr/local/bin/agent-mesh.js';

  const manifest = {
    meshVersion: '0.1.0',
    agents: [
      {
        name: 'solo',
        root: './solo',
        card: 'agent.json',
        served: true,
        enabledModes: ['ask'],
        peers: []
      }
    ]
  };

  const registry = generateRegistry(manifest, { meshRootAbs, binPath });
  const soloReg = registry['solo'];
  assert.ok(soloReg, 'solo registry must exist');
  assert.equal(soloReg['x-agentmesh-generated'], true);
  assert.deepEqual(soloReg.peers, {});
});

test('generateRegistry: marker is present on every entry', () => {
  const manifest = {
    meshVersion: '0.1.0',
    agents: [
      { name: 'a', root: './a', card: 'agent.json', served: true, enabledModes: ['ask'], peers: ['b'] },
      { name: 'b', root: './b', card: 'agent.json', served: true, enabledModes: ['do'], peers: [] }
    ]
  };
  const registry = generateRegistry(manifest, { meshRootAbs: '/m', binPath: '/bin/am.js' });
  for (const [, reg] of Object.entries(registry)) {
    assert.equal(reg['x-agentmesh-generated'], true);
  }
});

// ---------------------------------------------------------------------------
// readManifest / writeManifest round-trip
// ---------------------------------------------------------------------------

test('writeManifest injects x-agentmesh-generated marker', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'manifest-test-'));
  const manifest = {
    meshVersion: '0.1.0',
    agents: []
  };
  await writeManifest(tmp, manifest);
  const raw = JSON.parse(await readFile(join(tmp, 'mesh.json'), 'utf8'));
  assert.equal(raw['x-agentmesh-generated'], true);
  assert.equal(raw.meshVersion, '0.1.0');
});

test('readManifest / writeManifest round-trip', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'manifest-rtrip-'));
  const manifest = {
    meshVersion: '0.1.0',
    defaults: { transport: 'stdio' },
    agents: [
      {
        name: 'lib',
        root: './lib',
        card: 'agent.json',
        served: true,
        enabledModes: ['ask'],
        peers: []
      }
    ]
  };
  await writeManifest(tmp, manifest);
  const read = await readManifest(tmp);
  assert.equal(read.meshVersion, '0.1.0');
  assert.equal(read.agents[0].name, 'lib');
  assert.equal(read['x-agentmesh-generated'], true);
});

test('readManifest throws a clear error for missing mesh.json', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'manifest-missing-'));
  await assert.rejects(
    () => readManifest(tmp),
    (err) => {
      assert.ok(err.message.includes('mesh.json') || err.code === 'ENOENT');
      return true;
    }
  );
});

test('readManifest throws a clear error for invalid JSON', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'manifest-badjson-'));
  await writeFile(join(tmp, 'mesh.json'), 'not-json{{{');
  await assert.rejects(
    () => readManifest(tmp),
    (err) => {
      assert.ok(err.message.length > 0);
      return true;
    }
  );
});

test('writeManifest writes 2-space indented JSON', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'manifest-indent-'));
  await writeManifest(tmp, { meshVersion: '0.1.0', agents: [] });
  const raw = await readFile(join(tmp, 'mesh.json'), 'utf8');
  // 2-space indentation: second line should start with '  '
  const lines = raw.split('\n');
  assert.ok(lines.length > 1, 'must be multi-line');
  // At least one line is indented with 2 spaces
  assert.ok(lines.some(l => l.startsWith('  ')), 'must have 2-space indentation');
});
