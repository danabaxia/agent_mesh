/**
 * test/leave-join-propose.test.js
 *
 * Tests for Increment 2b: leave / join / proposed-patch.
 * All tests are hermetic (tmp dirs, no real claude, no network).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp, writeFile, mkdir, readFile, access, rm
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initMesh } from '../src/builder/init-mesh.js';
import { add } from '../src/builder/add.js';
import { leave } from '../src/builder/leave.js';
import { join as joinMesh } from '../src/builder/join.js';
import { proposePatch, proposedPath } from '../src/builder/propose.js';
import { readManifest } from '../src/builder/manifest.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function makeMesh() {
  const meshRoot = await mkdtemp(join(tmpdir(), 'ljp-mesh-'));
  await initMesh(meshRoot);
  return meshRoot;
}

/**
 * Minimal agent folder with an index.js source file.
 */
async function makeAgentFolder(opts = {}) {
  const src = await mkdtemp(join(tmpdir(), 'ljp-agent-'));
  await writeFile(join(src, 'index.js'), '// agent\n', 'utf8');

  if (opts.withAgentJson) {
    // Partial: missing x-agentmesh block entirely (triggers proposed-patch)
    const content = opts.partialAgentJson
      ? JSON.stringify({ name: opts.name || 'partial-agent', protocolVersion: '1.0', version: '0.1.0', skills: [] }, null, 2)
      : JSON.stringify({
          name: opts.name || 'agent',
          protocolVersion: '1.0',
          version: '0.1.0',
          skills: [],
          'x-agentmesh': { modes: ['ask'], meshVersion: '0.1.0' }
        }, null, 2);
    await writeFile(join(src, 'agent.json'), content + '\n', 'utf8');
  }
  if (opts.withMarkerlessRegistry) {
    await writeFile(join(src, 'registry.json'), JSON.stringify({ peers: {} }, null, 2), 'utf8');
  }
  return src;
}

/**
 * Add an agent to the mesh (apply=true) and return the result.
 */
async function addAgent(meshRoot, name, agentFolderOpts = {}) {
  const src = await makeAgentFolder(agentFolderOpts);
  return add(meshRoot, src, { name, modes: ['ask'], apply: true });
}

// ---------------------------------------------------------------------------
// leave: basic removal
// ---------------------------------------------------------------------------

test('leave: removes agent entry from mesh.json', async () => {
  const meshRoot = await makeMesh();
  await addAgent(meshRoot, 'alpha');
  await addAgent(meshRoot, 'beta');

  await leave(meshRoot, 'alpha');

  const manifest = await readManifest(meshRoot);
  assert.equal(manifest.agents.findIndex(a => a.name === 'alpha'), -1,
    'alpha must be removed from manifest');
  assert.ok(manifest.agents.find(a => a.name === 'beta'), 'beta must remain');
});

test('leave: returns structured result with removed entry', async () => {
  const meshRoot = await makeMesh();
  await addAgent(meshRoot, 'alpha');

  const result = await leave(meshRoot, 'alpha');

  assert.ok(result.removed, 'result must include removed entry');
  assert.equal(result.removed.name, 'alpha');
  assert.ok(Array.isArray(result.prunedFrom), 'prunedFrom must be an array');
  assert.ok(Array.isArray(result.registriesRegenerated), 'registriesRegenerated must be an array');
  assert.ok(Array.isArray(result.registriesUntouched), 'registriesUntouched must be an array');
  assert.ok(Array.isArray(result.warnings), 'warnings must be an array');
});

test('leave: throws when agent name not found in manifest', async () => {
  const meshRoot = await makeMesh();

  await assert.rejects(
    () => leave(meshRoot, 'nonexistent'),
    (err) => {
      assert.ok(err.message.includes('nonexistent'), `Error should mention name, got: ${err.message}`);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// leave: peer pruning
// ---------------------------------------------------------------------------

test('leave: prunes departed name from every remaining agent peers[]', async () => {
  const meshRoot = await makeMesh();

  // Add X, Y, Z
  await addAgent(meshRoot, 'x');
  await addAgent(meshRoot, 'y');
  await addAgent(meshRoot, 'z');

  // Wire Y → X and Z → X in the manifest
  const manifest = await readManifest(meshRoot);
  const y = manifest.agents.find(a => a.name === 'y');
  const z = manifest.agents.find(a => a.name === 'z');
  y.peers = ['x'];
  z.peers = ['x'];

  // Write updated manifest
  const { writeManifest } = await import('../src/builder/manifest.js');
  await writeManifest(meshRoot, manifest);

  // Now leave X
  const result = await leave(meshRoot, 'x');

  // prunedFrom should list y and z
  assert.ok(result.prunedFrom.includes('y'), 'y must be in prunedFrom');
  assert.ok(result.prunedFrom.includes('z'), 'z must be in prunedFrom');

  // Read manifest and verify peers are pruned
  const updated = await readManifest(meshRoot);
  const updatedY = updated.agents.find(a => a.name === 'y');
  const updatedZ = updated.agents.find(a => a.name === 'z');
  assert.ok(!updatedY.peers.includes('x'), 'y must not list x as peer after leave');
  assert.ok(!updatedZ.peers.includes('x'), 'z must not list x as peer after leave');
});

test('leave: regenerated registries for remaining agents do not reference departed peer', async () => {
  const meshRoot = await makeMesh();

  await addAgent(meshRoot, 'x');
  await addAgent(meshRoot, 'y');
  await addAgent(meshRoot, 'z');

  // Wire Y → X and Z → X
  const manifest = await readManifest(meshRoot);
  manifest.agents.find(a => a.name === 'y').peers = ['x'];
  manifest.agents.find(a => a.name === 'z').peers = ['x'];
  const { writeManifest } = await import('../src/builder/manifest.js');
  await writeManifest(meshRoot, manifest);

  await leave(meshRoot, 'x');

  // Y's registry.json must not mention x
  const yRegistry = JSON.parse(await readFile(join(meshRoot, 'y', 'registry.json'), 'utf8'));
  assert.ok(!(Object.keys(yRegistry.peers).includes('x')), 'y registry must not list x');

  // Z's registry.json must not mention x
  const zRegistry = JSON.parse(await readFile(join(meshRoot, 'z', 'registry.json'), 'utf8'));
  assert.ok(!(Object.keys(zRegistry.peers).includes('x')), 'z registry must not list x');
});

// ---------------------------------------------------------------------------
// leave: registry.json file handling
// ---------------------------------------------------------------------------

test('leave: deletes managed (marker present) registry.json of departing agent', async () => {
  const meshRoot = await makeMesh();
  await addAgent(meshRoot, 'alpha');

  // Ensure the registry has the marker
  const regPath = join(meshRoot, 'alpha', 'registry.json');
  const raw = JSON.parse(await readFile(regPath, 'utf8'));
  assert.equal(raw['x-agentmesh-generated'], true, 'fixture: registry must be marked');

  await leave(meshRoot, 'alpha');

  // Registry.json must be deleted
  let exists = false;
  try { await access(regPath); exists = true; } catch { /* expected */ }
  assert.equal(exists, false, 'managed registry.json must be deleted on leave');
});

test('leave: leaves Authored (markerless) registry.json of departing agent untouched', async () => {
  const meshRoot = await makeMesh();
  // Create agent slot manually with markerless registry.json
  const agentDir = join(meshRoot, 'gamma');
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, 'registry.json'), JSON.stringify({ peers: {} }), 'utf8');
  await writeFile(join(agentDir, 'index.js'), '// gamma\n', 'utf8');

  // Register in manifest manually
  const manifest = await readManifest(meshRoot);
  manifest.agents.push({
    name: 'gamma', root: './gamma', card: 'agent.json',
    served: true, enabledModes: ['ask'], peers: []
  });
  const { writeManifest } = await import('../src/builder/manifest.js');
  await writeManifest(meshRoot, manifest);

  const result = await leave(meshRoot, 'gamma');

  // Registry.json must still exist
  const regPath = join(agentDir, 'registry.json');
  await assert.doesNotReject(() => access(regPath), 'Authored registry.json must still exist');

  // Result must report it as untouched and warn
  assert.ok(result.warnings.some(w => w.includes('gamma') && w.toLowerCase().includes('authored')),
    'must warn about authored registry');
});

test('leave: reports Authored registry.json in warnings and registriesUntouched', async () => {
  const meshRoot = await makeMesh();

  // Build a mesh with two agents; one of the remaining has an authored registry
  await addAgent(meshRoot, 'alpha');
  await addAgent(meshRoot, 'beta');

  // Replace beta's registry.json with a markerless (Authored) one
  const betaRegPath = join(meshRoot, 'beta', 'registry.json');
  await writeFile(betaRegPath, JSON.stringify({ peers: {} }), 'utf8');

  // Now leave alpha — beta's registry should be skipped with a warning
  const result = await leave(meshRoot, 'alpha');

  assert.ok(result.registriesUntouched.includes(betaRegPath),
    'beta authored registry must be in registriesUntouched');
  assert.ok(result.warnings.some(w => w.includes('beta')),
    'warning must mention beta');
});

// ---------------------------------------------------------------------------
// join: in-place rejoin
// ---------------------------------------------------------------------------

test('join: re-registers in-tree agent in manifest', async () => {
  const meshRoot = await makeMesh();
  await addAgent(meshRoot, 'alpha');

  await leave(meshRoot, 'alpha');

  // alpha folder still exists (leave does not delete the folder)
  const result = await joinMesh(meshRoot, 'alpha');

  assert.equal(result.name, 'alpha');
  const manifest = await readManifest(meshRoot);
  const entry = manifest.agents.find(a => a.name === 'alpha');
  assert.ok(entry, 'alpha must be back in manifest after join');
});

test('join: rejoin-after-leave succeeds without re-copying and without collision error', async () => {
  const meshRoot = await makeMesh();
  const src = await makeAgentFolder();
  const addResult = await add(meshRoot, src, { name: 'agent1', modes: ['ask'], apply: true });
  assert.equal(addResult.dryRun, false, 'add should have applied');

  await leave(meshRoot, 'agent1');

  // join should succeed without errors
  const joinResult = await joinMesh(meshRoot, 'agent1');
  assert.equal(joinResult.name, 'agent1');

  // Must be back in manifest
  const manifest = await readManifest(meshRoot);
  assert.ok(manifest.agents.find(a => a.name === 'agent1'), 'agent1 must be re-registered');

  // Must have regenerated a registry
  const regPath = join(meshRoot, 'agent1', 'registry.json');
  const reg = JSON.parse(await readFile(regPath, 'utf8'));
  assert.equal(reg['x-agentmesh-generated'], true);
});

test('join: refuses an out-of-tree folder path', async () => {
  const meshRoot = await makeMesh();
  const externalFolder = await mkdtemp(join(tmpdir(), 'external-'));
  await writeFile(join(externalFolder, 'index.js'), '// ext', 'utf8');

  await assert.rejects(
    () => joinMesh(meshRoot, externalFolder),
    (err) => {
      assert.ok(
        err.message.toLowerCase().includes('add') ||
        err.message.toLowerCase().includes('in-tree') ||
        err.message.toLowerCase().includes('not') ||
        err.message.toLowerCase().includes('inside'),
        `Expected refusal error mentioning "add" or in-tree, got: ${err.message}`
      );
      return true;
    }
  );
});

test('join: refuses when folder does not exist in mesh root', async () => {
  const meshRoot = await makeMesh();

  await assert.rejects(
    () => joinMesh(meshRoot, 'nonexistent-agent'),
    (err) => {
      assert.ok(
        err.message.toLowerCase().includes('not exist') ||
        err.message.toLowerCase().includes('does not') ||
        err.message.toLowerCase().includes('add'),
        `Expected "does not exist" error, got: ${err.message}`
      );
      return true;
    }
  );
});

test('join: regenerates managed registry.json', async () => {
  const meshRoot = await makeMesh();
  const src = await makeAgentFolder();
  await add(meshRoot, src, { name: 'myagent', modes: ['ask'], apply: true });
  await leave(meshRoot, 'myagent');

  // Registry must have been deleted by leave
  const regPath = join(meshRoot, 'myagent', 'registry.json');
  let existsBeforeJoin = false;
  try { await access(regPath); existsBeforeJoin = true; } catch { /* expected */ }
  assert.equal(existsBeforeJoin, false, 'registry must be deleted by leave');

  await joinMesh(meshRoot, 'myagent');

  const reg = JSON.parse(await readFile(regPath, 'utf8'));
  assert.equal(reg['x-agentmesh-generated'], true, 'registry must be regenerated by join');
});

// ---------------------------------------------------------------------------
// join: Authored registry.json is not overwritten
// ---------------------------------------------------------------------------

test('join: does not overwrite Authored (markerless) registry.json and warns', async () => {
  const meshRoot = await makeMesh();

  // Create in-tree agent folder with a markerless registry
  const agentDir = join(meshRoot, 'stand-alone');
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, 'index.js'), '// standalone\n', 'utf8');
  const authoredContent = JSON.stringify({ peers: { 'hand-authored': {} } });
  await writeFile(join(agentDir, 'registry.json'), authoredContent, 'utf8');

  const result = await joinMesh(meshRoot, 'stand-alone');

  // Authored registry.json must be unchanged
  const regContent = await readFile(join(agentDir, 'registry.json'), 'utf8');
  assert.equal(regContent, authoredContent, 'Authored registry.json must not be overwritten by join');

  assert.ok(result.registriesUntouched.includes(join(agentDir, 'registry.json')),
    'registry must be in registriesUntouched');
  assert.ok(result.warnings.some(w => w.includes('stand-alone')),
    'warning must mention the agent name');
});

// ---------------------------------------------------------------------------
// proposed-patch: propose.js unit tests
// ---------------------------------------------------------------------------

test('proposePatch: writes <path>.proposed and returns the proposed path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'propose-'));
  const filePath = join(dir, 'agent.json');
  await writeFile(filePath, '{}', 'utf8'); // live file

  const proposed = await proposePatch(filePath, '{"proposed": true}');

  assert.equal(proposed, filePath + '.proposed');
  const content = await readFile(proposed, 'utf8');
  assert.equal(content, '{"proposed": true}');

  // Original must be untouched
  const original = await readFile(filePath, 'utf8');
  assert.equal(original, '{}');
});

test('proposedPath: returns path + .proposed', () => {
  assert.equal(proposedPath('/foo/bar/agent.json'), '/foo/bar/agent.json.proposed');
  assert.equal(proposedPath('agent.json'), 'agent.json.proposed');
});

test('proposePatch: does not overwrite the live file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'propose2-'));
  const filePath = join(dir, 'target.json');
  const originalContent = '{"original": true}';
  await writeFile(filePath, originalContent, 'utf8');

  await proposePatch(filePath, '{"patch": true}');

  const after = await readFile(filePath, 'utf8');
  assert.equal(after, originalContent, 'live file must remain unchanged after proposePatch');
});

// ---------------------------------------------------------------------------
// proposed-patch: add with existing-but-partial agent.json
// ---------------------------------------------------------------------------

test('add --apply: existing agent.json missing x-agentmesh.modes → emits .proposed, does NOT edit in place', async () => {
  const meshRoot = await makeMesh();

  // Create an agent folder with a partial agent.json (missing x-agentmesh block)
  const src = await makeAgentFolder({ withAgentJson: true, partialAgentJson: true, name: 'partial' });

  const result = await add(meshRoot, src, { name: 'partial', modes: ['ask'], apply: true });

  // proposedFiles should include agent.json.proposed
  assert.ok(Array.isArray(result.proposedFiles), 'result must include proposedFiles');
  const proposedAgentJson = result.proposedFiles.find(p => p.endsWith('agent.json.proposed'));
  assert.ok(proposedAgentJson, 'should have emitted agent.json.proposed');

  // The live agent.json in dest must NOT be modified (still missing x-agentmesh)
  const destAgentJson = JSON.parse(await readFile(join(meshRoot, 'partial', 'agent.json'), 'utf8'));
  assert.ok(!destAgentJson['x-agentmesh'], 'live agent.json must not be edited in place');

  // The proposed file must contain the x-agentmesh.modes field
  const proposedContent = JSON.parse(await readFile(proposedAgentJson, 'utf8'));
  assert.ok(Array.isArray(proposedContent['x-agentmesh']?.modes),
    'proposed file must contain x-agentmesh.modes');
});

test('add --apply: fully-formed agent.json does NOT emit .proposed', async () => {
  const meshRoot = await makeMesh();

  // Agent folder with complete agent.json (has x-agentmesh.modes and meshVersion)
  const src = await makeAgentFolder({ withAgentJson: true, name: 'complete' });

  const result = await add(meshRoot, src, { name: 'complete', modes: ['ask'], apply: true });

  assert.ok(Array.isArray(result.proposedFiles), 'proposedFiles must be an array');
  const proposedAgentJson = result.proposedFiles.find(p => p.endsWith('agent.json.proposed'));
  assert.equal(proposedAgentJson, undefined,
    'no .proposed file should be emitted for a complete agent.json');
});

test('add --apply: absent agent.json is scaffolded directly (not proposed)', async () => {
  const meshRoot = await makeMesh();
  // No agent.json in source
  const src = await makeAgentFolder();

  const result = await add(meshRoot, src, { name: 'fresh', modes: ['ask'], apply: true });

  // agent.json should be in createdFiles (scaffolded)
  const created = result.createdFiles.find(p => p.endsWith('agent.json'));
  assert.ok(created, 'absent agent.json must be scaffolded directly');

  // No proposed file
  const proposed = result.proposedFiles?.find(p => p.endsWith('agent.json.proposed'));
  assert.equal(proposed, undefined, 'absent agent.json should not emit .proposed');
});
