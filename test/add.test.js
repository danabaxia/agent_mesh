/**
 * test/add.test.js
 *
 * Tests for src/builder/add.js — the orchestrator.
 * All tests use tmp dirs; hermetic (no real claude, no network).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp, writeFile, mkdir, readFile, access, stat
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { add } from '../src/builder/add.js';
import { initMesh } from '../src/builder/init-mesh.js';
import { readManifest, validateManifest } from '../src/builder/manifest.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function makeAgentFolder(overrides = {}) {
  const src = await mkdtemp(join(tmpdir(), 'add-agent-'));
  // A minimal agent folder — just a source file by default
  await writeFile(join(src, 'index.js'), '// agent code\n', 'utf8');
  if (overrides.withSystemPrompt) {
    await mkdir(join(src, 'prompts'), { recursive: true });
    await writeFile(join(src, 'prompts', 'system.md'), '# System\nI am an agent.', 'utf8');
  }
  if (overrides.withAgentJson) {
    await writeFile(join(src, 'agent.json'), JSON.stringify({
      name: 'existing',
      protocolVersion: '1.0',
      version: '0.1.0',
      skills: [],
      'x-agentmesh': { modes: ['ask'], meshVersion: '0.1.0' }
    }, null, 2), 'utf8');
  }
  if (overrides.withToolServer) {
    await mkdir(join(src, 'tools', 'search'), { recursive: true });
    await writeFile(join(src, 'tools', 'search', 'server.mjs'), '// mcp server\n', 'utf8');
  }
  if (overrides.withMarkedRegistry) {
    await writeFile(join(src, 'registry.json'), JSON.stringify({
      'x-agentmesh-generated': true, peers: {}
    }, null, 2), 'utf8');
  }
  if (overrides.withMarkerlessRegistry) {
    await writeFile(join(src, 'registry.json'), JSON.stringify({ peers: {} }, null, 2), 'utf8');
  }
  return src;
}

async function makeMesh() {
  const meshRoot = await mkdtemp(join(tmpdir(), 'add-mesh-'));
  await initMesh(meshRoot);
  return meshRoot;
}

// ---------------------------------------------------------------------------
// Dry-run: default writes nothing
// ---------------------------------------------------------------------------

test('add: dry-run (default) writes nothing to disk', async () => {
  const meshRoot = await makeMesh();
  const agentFolder = await makeAgentFolder();

  const plan = await add(meshRoot, agentFolder, { name: 'myagent', modes: ['ask'] });

  // The plan is returned
  assert.ok(plan, 'dry-run must return a plan');

  // Destination must NOT exist after dry-run
  let destExists = false;
  try {
    await access(join(meshRoot, 'myagent'));
    destExists = true;
  } catch { /* expected */ }
  assert.equal(destExists, false, 'dry-run must not create destination folder');

  // mesh.json agents array must still be empty
  const manifest = await readManifest(meshRoot);
  assert.equal(manifest.agents.length, 0, 'dry-run must not modify mesh.json');
});

test('add: dry-run plan describes copy, scaffold, manifest entry', async () => {
  const meshRoot = await makeMesh();
  const agentFolder = await makeAgentFolder();

  const plan = await add(meshRoot, agentFolder, { name: 'myagent', modes: ['ask'] });

  assert.ok(plan.manifestEntry, 'plan must include manifestEntry');
  assert.equal(plan.manifestEntry.name, 'myagent');
  assert.ok(plan.scaffold, 'plan must include scaffold list');
  assert.ok(Array.isArray(plan.scaffold), 'scaffold must be an array');
});

// ---------------------------------------------------------------------------
// apply: copies files, scaffolds, upserts manifest, writes registry.json
// ---------------------------------------------------------------------------

test('add --apply: copies source into mesh root under agent name', async () => {
  const meshRoot = await makeMesh();
  const agentFolder = await makeAgentFolder();

  await add(meshRoot, agentFolder, { name: 'myagent', modes: ['ask'], apply: true });

  // dest folder must exist
  const destStat = await stat(join(meshRoot, 'myagent'));
  assert.ok(destStat.isDirectory(), 'dest dir must exist');

  // source file must be there
  const code = await readFile(join(meshRoot, 'myagent', 'index.js'), 'utf8');
  assert.equal(code, '// agent code\n');
});

test('add --apply: upserts agent entry into mesh.json', async () => {
  const meshRoot = await makeMesh();
  const agentFolder = await makeAgentFolder();

  await add(meshRoot, agentFolder, { name: 'myagent', modes: ['ask'], apply: true });

  const manifest = await readManifest(meshRoot);
  const entry = manifest.agents.find(a => a.name === 'myagent');
  assert.ok(entry, 'agent entry must exist in manifest');
  assert.equal(entry.name, 'myagent');
  assert.ok(entry.root.includes('myagent'), 'root must reference agent name');
  assert.equal(entry.served, true);
  assert.deepEqual(entry.enabledModes, ['ask']);
  assert.deepEqual(entry.peers, []);
});

test('add --apply: manifest is valid after upsert', async () => {
  const meshRoot = await makeMesh();
  const agentFolder = await makeAgentFolder();

  await add(meshRoot, agentFolder, { name: 'myagent', modes: ['ask'], apply: true });

  const manifest = await readManifest(meshRoot);
  const { ok, errors } = validateManifest(manifest);
  assert.equal(ok, true, `manifest must be valid after add --apply: ${errors.join(', ')}`);
});

test('add --apply: writes marker-stamped registry.json for the agent', async () => {
  const meshRoot = await makeMesh();
  const agentFolder = await makeAgentFolder();

  await add(meshRoot, agentFolder, { name: 'myagent', modes: ['ask'], apply: true });

  const registryPath = join(meshRoot, 'myagent', 'registry.json');
  const raw = JSON.parse(await readFile(registryPath, 'utf8'));
  assert.equal(raw['x-agentmesh-generated'], true, 'registry.json must have x-agentmesh-generated marker');
  assert.ok(typeof raw.peers === 'object', 'registry.json must have peers object');
});

test('add --apply: scaffolds missing agent.json in dest', async () => {
  const meshRoot = await makeMesh();
  const agentFolder = await makeAgentFolder(); // no agent.json

  await add(meshRoot, agentFolder, { name: 'myagent', modes: ['ask'], apply: true });

  const agentJsonPath = join(meshRoot, 'myagent', 'agent.json');
  const raw = JSON.parse(await readFile(agentJsonPath, 'utf8'));
  assert.equal(raw.name, 'myagent');
  assert.equal(raw['x-agentmesh'].meshVersion, '0.1.0');
});

test('add --apply: scaffolds missing prompts/system.md in dest', async () => {
  const meshRoot = await makeMesh();
  const agentFolder = await makeAgentFolder();

  await add(meshRoot, agentFolder, { name: 'myagent', modes: ['ask'], role: 'Test role', apply: true });

  const systemPath = join(meshRoot, 'myagent', 'prompts', 'system.md');
  const content = await readFile(systemPath, 'utf8');
  assert.ok(content.length > 0, 'system.md must have content');
});

test('add --apply: does NOT clobber existing agent.json in source (copied, not overwritten)', async () => {
  const meshRoot = await makeMesh();
  const agentFolder = await makeAgentFolder({ withAgentJson: true });

  await add(meshRoot, agentFolder, { name: 'existing', modes: ['ask'], apply: true });

  // The copied agent.json should be the original one (from source), NOT overwritten
  const destAgentJson = JSON.parse(await readFile(join(meshRoot, 'existing', 'agent.json'), 'utf8'));
  // Original has name: 'existing' from fixture
  assert.equal(destAgentJson.name, 'existing');
  // scaffold should NOT have been applied (file existed)
  // The x-agentmesh block from the original file should be preserved
  assert.ok(destAgentJson['x-agentmesh'], 'x-agentmesh block must be from original');
});

// ---------------------------------------------------------------------------
// refuses markerless registry.json
// ---------------------------------------------------------------------------

test('add --apply: refuses to overwrite markerless registry.json in dest', async () => {
  const meshRoot = await makeMesh();
  // Put a markerless registry.json in the mesh root's agent slot ahead of time
  const agentSlot = join(meshRoot, 'myagent');
  await mkdir(agentSlot, { recursive: true });
  await writeFile(join(agentSlot, 'registry.json'), JSON.stringify({ peers: {} }), 'utf8');
  await writeFile(join(agentSlot, 'other.txt'), 'existing', 'utf8');

  const agentFolder = await makeAgentFolder();

  // Use force so collision doesn't block us — we want to test the registry refusal
  await assert.rejects(
    () => add(meshRoot, agentFolder, { name: 'myagent', modes: ['ask'], apply: true, force: true }),
    (err) => {
      assert.ok(
        err.message.toLowerCase().includes('registry') ||
        err.message.toLowerCase().includes('marker') ||
        err.message.toLowerCase().includes('authored'),
        `Expected registry refusal error, got: ${err.message}`
      );
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// agent-root containment — refuses dest outside mesh root
// ---------------------------------------------------------------------------

test('add: refuses dest that would escape mesh root', async () => {
  const meshRoot = await makeMesh();
  const agentFolder = await makeAgentFolder();

  // Use a name with path traversal
  await assert.rejects(
    () => add(meshRoot, agentFolder, { name: '../escape', modes: ['ask'], apply: true }),
    (err) => {
      assert.ok(
        err.message.toLowerCase().includes('containment') ||
        err.message.toLowerCase().includes('escape') ||
        err.message.toLowerCase().includes('outside') ||
        err.message.toLowerCase().includes('root') ||
        err.message.toLowerCase().includes('inside'),
        `Expected containment error, got: ${err.message}`
      );
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// idempotence — re-running add refreshes managed files
// ---------------------------------------------------------------------------

test('add --apply: idempotent — second run does not fail on same agent', async () => {
  const meshRoot = await makeMesh();
  const agentFolder = await makeAgentFolder();

  await add(meshRoot, agentFolder, { name: 'myagent', modes: ['ask'], apply: true });
  // Second run with force (to handle non-empty dest)
  await add(meshRoot, agentFolder, { name: 'myagent', modes: ['ask'], apply: true, force: true });

  // Should still have exactly one agent entry
  const manifest = await readManifest(meshRoot);
  const entries = manifest.agents.filter(a => a.name === 'myagent');
  assert.equal(entries.length, 1, 'must not duplicate manifest entries on repeat add');
});

// ---------------------------------------------------------------------------
// result shape
// ---------------------------------------------------------------------------

test('add --apply: result includes createdFiles, manifestEntry, registryFiles, skipped', async () => {
  const meshRoot = await makeMesh();
  const agentFolder = await makeAgentFolder();

  const result = await add(meshRoot, agentFolder, { name: 'myagent', modes: ['ask'], apply: true });

  assert.ok(result.manifestEntry, 'result must include manifestEntry');
  assert.ok(Array.isArray(result.createdFiles), 'result must include createdFiles array');
  assert.ok(Array.isArray(result.registryFiles), 'result must include registryFiles array');
  assert.ok(Array.isArray(result.skipped), 'result must include skipped array');
});

// ---------------------------------------------------------------------------
// basename inference for name
// ---------------------------------------------------------------------------

test('add: infers name from agent folder basename when not provided', async () => {
  const meshRoot = await makeMesh();
  // Create folder with a specific name
  const parent = await mkdtemp(join(tmpdir(), 'add-named-'));
  const agentFolder = join(parent, 'my-special-agent');
  await mkdir(agentFolder);
  await writeFile(join(agentFolder, 'code.js'), 'x', 'utf8');

  const plan = await add(meshRoot, agentFolder, { modes: ['ask'] });
  assert.equal(plan.manifestEntry.name, 'my-special-agent');
});
