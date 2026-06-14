/**
 * test/conformance.test.js
 *
 * Tests for src/builder/conformance.js — one focused test per rule.
 * All tests use tmp dirs; hermetic (no real claude, no network).
 *
 * Pattern:
 *   - Build a clean agent, verify it passes all relevant rules
 *   - Introduce a specific violation, verify the right rule fails/warns
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp, writeFile, mkdir, readFile, rm
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadSnapshot, checkConformance, CURRENT_MESH_VERSION } from '../src/builder/conformance.js';
import { initMesh } from '../src/builder/init-mesh.js';
import { writeManifest, generateRegistry } from '../src/builder/manifest.js';
import { CANONICAL_DIRS } from '../src/builder/scaffold.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal valid agent.json object.
 */
function minimalAgentJson(name = 'test-agent', modes = ['ask']) {
  return {
    name,
    protocolVersion: '1.0',
    version: '0.1.0',
    skills: [],
    'x-agentmesh': {
      modes,
      meshVersion: CURRENT_MESH_VERSION
    }
  };
}

/**
 * Scaffold a complete, conformant agent folder inside meshRoot.
 *
 * @param {string} meshRoot  absolute mesh root path
 * @param {string} name      agent name
 * @param {object} [opts]
 *   modes, extraAgentJson, skipSystemMd, skipAgentJson
 * @returns {string} agentRoot
 */
async function makeConformantAgent(meshRoot, name, opts = {}) {
  const { modes = ['ask'], extraAgentJson = {}, skipSystemMd = false, skipAgentJson = false } = opts;
  const agentRoot = join(meshRoot, name);
  await mkdir(join(agentRoot, 'prompts'), { recursive: true });

  if (!skipAgentJson) {
    const agentJson = { ...minimalAgentJson(name, modes), ...extraAgentJson };
    await writeFile(join(agentRoot, 'agent.json'), JSON.stringify(agentJson, null, 2), 'utf8');
  }
  if (!skipSystemMd) {
    await writeFile(join(agentRoot, 'prompts', 'system.md'), `# ${name}\nYou are ${name}.`, 'utf8');
  }
  // Canonical directory structure (spec 2026-06-10 §4) — a conformant agent has it
  for (const dir of CANONICAL_DIRS) {
    await mkdir(join(agentRoot, dir), { recursive: true });
  }
  return agentRoot;
}

/**
 * Create a mesh with one agent, return { meshRoot, agentRoot, manifest }.
 */
async function makeSimpleMesh(agentName = 'agent-a', modes = ['ask']) {
  const meshRoot = await mkdtemp(join(tmpdir(), 'conf-mesh-'));
  await initMesh(meshRoot);

  const agentRoot = await makeConformantAgent(meshRoot, agentName, { modes });

  const manifest = {
    meshVersion: '0.1.0',
    agents: [
      {
        name: agentName,
        root: `./${agentName}`,
        card: 'agent.json',
        served: true,
        enabledModes: modes,
        peers: []
      }
    ]
  };
  await writeManifest(meshRoot, manifest);

  // Write a matching registry.json for the agent
  const registries = generateRegistry(manifest, {
    meshRootAbs: meshRoot,
    binPath: '/bin/agent-mesh.js'
  });
  await writeFile(
    join(agentRoot, 'registry.json'),
    JSON.stringify(registries[agentName], null, 2) + '\n',
    'utf8'
  );

  return { meshRoot, agentRoot, manifest };
}

// ---------------------------------------------------------------------------
// Rule: Anatomy
// ---------------------------------------------------------------------------

test('conformance anatomy: clean agent passes', async () => {
  const { meshRoot } = await makeSimpleMesh();
  const snapshot = await loadSnapshot(meshRoot);
  const report = checkConformance(snapshot);

  const anatomyRules = report.rules.filter(r => r.rule === 'anatomy');
  assert.ok(anatomyRules.length > 0, 'anatomy rules must be present');
  assert.ok(
    anatomyRules.every(r => r.level === 'pass'),
    `Expected all anatomy rules to pass, got: ${JSON.stringify(anatomyRules)}`
  );
});

test('conformance anatomy: missing agent.json fails', async () => {
  const { meshRoot, agentRoot } = await makeSimpleMesh();
  // Remove agent.json
  await rm(join(agentRoot, 'agent.json'));

  const snapshot = await loadSnapshot(meshRoot);
  const report = checkConformance(snapshot);

  const failRules = report.rules.filter(r => r.rule === 'anatomy' && r.level === 'fail');
  assert.ok(failRules.length > 0, 'anatomy should fail when agent.json is missing');
  assert.ok(failRules.some(r => /agent\.json/i.test(r.detail)));
  assert.equal(report.ok, false);
});

test('conformance anatomy: missing prompts/system.md fails', async () => {
  const { meshRoot, agentRoot } = await makeSimpleMesh();
  // Remove system.md
  await rm(join(agentRoot, 'prompts', 'system.md'));

  const snapshot = await loadSnapshot(meshRoot);
  const report = checkConformance(snapshot);

  const failRules = report.rules.filter(r => r.rule === 'anatomy' && r.level === 'fail');
  assert.ok(failRules.length > 0, 'anatomy should fail when prompts/system.md is missing');
  assert.ok(failRules.some(r => /system\.md/i.test(r.detail)));
  assert.equal(report.ok, false);
});

// ---------------------------------------------------------------------------
// Rule: Tools
// ---------------------------------------------------------------------------

test('conformance tools: clean agent with no tools passes', async () => {
  const { meshRoot } = await makeSimpleMesh();
  const snapshot = await loadSnapshot(meshRoot);
  const report = checkConformance(snapshot);

  const toolRules = report.rules.filter(r => r.rule === 'tools');
  assert.ok(toolRules.length > 0);
  assert.ok(toolRules.every(r => r.level === 'pass'));
});

test('conformance tools: undeclared server.mjs fails', async () => {
  const { meshRoot, agentRoot } = await makeSimpleMesh();
  // Add a tool server WITHOUT declaring it in .mcp.json
  await mkdir(join(agentRoot, 'tools', 'search'), { recursive: true });
  await writeFile(join(agentRoot, 'tools', 'search', 'server.mjs'), '// mcp server\n', 'utf8');

  const snapshot = await loadSnapshot(meshRoot);
  const report = checkConformance(snapshot);

  const failRules = report.rules.filter(r => r.rule === 'tools' && r.level === 'fail');
  assert.ok(failRules.length > 0, 'tools should fail: server.mjs not declared in .mcp.json');
  assert.ok(failRules.some(r => /\.mcp\.json/i.test(r.detail) || /declared/i.test(r.detail)));
  assert.equal(report.ok, false);
});

test('conformance tools: dangling .mcp.json declaration fails', async () => {
  const { meshRoot, agentRoot } = await makeSimpleMesh();
  // .mcp.json declares a server but the server.mjs file does not exist
  const mcpJson = {
    mcpServers: {
      ghost: {
        type: 'stdio',
        command: 'node',
        args: ['tools/ghost/server.mjs']
      }
    }
  };
  await writeFile(join(agentRoot, '.mcp.json'), JSON.stringify(mcpJson, null, 2), 'utf8');

  const snapshot = await loadSnapshot(meshRoot);
  const report = checkConformance(snapshot);

  const failRules = report.rules.filter(r => r.rule === 'tools' && r.level === 'fail');
  assert.ok(failRules.length > 0, 'tools should fail: dangling .mcp.json declaration');
  assert.ok(failRules.some(r => /ghost/i.test(r.detail) || /dangling/i.test(r.detail) || /not found/i.test(r.detail)));
  assert.equal(report.ok, false);
});

test('conformance tools: declared server.mjs passes', async () => {
  const { meshRoot, agentRoot } = await makeSimpleMesh();
  // Add a tool server AND declare it in .mcp.json
  await mkdir(join(agentRoot, 'tools', 'search'), { recursive: true });
  await writeFile(join(agentRoot, 'tools', 'search', 'server.mjs'), '// mcp server\n', 'utf8');
  const mcpJson = {
    mcpServers: {
      search: {
        type: 'stdio',
        command: 'node',
        args: ['tools/search/server.mjs']
      }
    }
  };
  await writeFile(join(agentRoot, '.mcp.json'), JSON.stringify(mcpJson, null, 2), 'utf8');

  const snapshot = await loadSnapshot(meshRoot);
  const report = checkConformance(snapshot);

  const failRules = report.rules.filter(r => r.rule === 'tools' && r.level === 'fail');
  assert.equal(failRules.length, 0, `Expected no tool fails, got: ${JSON.stringify(failRules)}`);
});

// ---------------------------------------------------------------------------
// Rule: Card
// ---------------------------------------------------------------------------

test('conformance card: valid agent.json passes card check', async () => {
  const { meshRoot } = await makeSimpleMesh();
  const snapshot = await loadSnapshot(meshRoot);
  const report = checkConformance(snapshot);

  const cardRules = report.rules.filter(r => r.rule === 'card');
  assert.ok(cardRules.every(r => r.level === 'pass'), `card rules: ${JSON.stringify(cardRules)}`);
});

test('conformance card: missing agent.json fails card check', async () => {
  const { meshRoot, agentRoot } = await makeSimpleMesh();
  await rm(join(agentRoot, 'agent.json'));

  const snapshot = await loadSnapshot(meshRoot);
  const report = checkConformance(snapshot);

  const cardFail = report.rules.filter(r => r.rule === 'card' && r.level === 'fail');
  assert.ok(cardFail.length > 0, 'card should fail when agent.json is missing');
});

// ---------------------------------------------------------------------------
// Rule: Wiring (mesh-level)
// ---------------------------------------------------------------------------

test('conformance wiring: no peers, no registry — passes', async () => {
  const { meshRoot } = await makeSimpleMesh();
  const snapshot = await loadSnapshot(meshRoot);
  const report = checkConformance(snapshot);

  const wiringPass = report.rules.filter(r => r.rule === 'wiring' && r.level === 'pass');
  assert.ok(wiringPass.length > 0, 'wiring should pass for no-peer agent');
});

test('conformance wiring: dangling peer (peer not in manifest) fails', async () => {
  const meshRoot = await mkdtemp(join(tmpdir(), 'conf-wire-'));
  await initMesh(meshRoot);
  await makeConformantAgent(meshRoot, 'agent-a');

  // Set agent-a to have a peer "ghost" that doesn't exist
  const manifest = {
    meshVersion: '0.1.0',
    agents: [
      {
        name: 'agent-a',
        root: './agent-a',
        card: 'agent.json',
        served: true,
        enabledModes: ['ask'],
        peers: ['ghost']  // dangling
      }
    ]
  };
  await writeManifest(meshRoot, manifest);

  const snapshot = await loadSnapshot(meshRoot);
  const report = checkConformance(snapshot);

  const wiringFail = report.rules.filter(r => r.rule === 'wiring' && r.level === 'fail');
  assert.ok(wiringFail.length > 0, 'wiring should fail for dangling peer');
  assert.ok(wiringFail.some(r => /ghost/i.test(r.detail) || /dangling/i.test(r.detail)));
  assert.equal(report.ok, false);
});

test('conformance wiring: peer with served:false fails', async () => {
  const meshRoot = await mkdtemp(join(tmpdir(), 'conf-wire2-'));
  await initMesh(meshRoot);
  await makeConformantAgent(meshRoot, 'agent-a');
  await makeConformantAgent(meshRoot, 'agent-b');

  const manifest = {
    meshVersion: '0.1.0',
    agents: [
      {
        name: 'agent-a',
        root: './agent-a',
        card: 'agent.json',
        served: true,
        enabledModes: ['ask'],
        peers: ['agent-b']
      },
      {
        name: 'agent-b',
        root: './agent-b',
        card: 'agent.json',
        served: false,  // not served
        enabledModes: [],
        peers: []
      }
    ]
  };
  await writeManifest(meshRoot, manifest);

  const snapshot = await loadSnapshot(meshRoot);
  const report = checkConformance(snapshot);

  const wiringFail = report.rules.filter(r => r.rule === 'wiring' && r.level === 'fail');
  assert.ok(wiringFail.length > 0, 'wiring should fail: peer is served:false');
  assert.ok(wiringFail.some(r => /agent-b/i.test(r.detail) || /served/i.test(r.detail)));
  assert.equal(report.ok, false);
});

test('conformance wiring: drifted registry.json fails', async () => {
  const meshRoot = await mkdtemp(join(tmpdir(), 'conf-drift-'));
  await initMesh(meshRoot);
  await makeConformantAgent(meshRoot, 'agent-a');
  await makeConformantAgent(meshRoot, 'agent-b');

  const manifest = {
    meshVersion: '0.1.0',
    agents: [
      {
        name: 'agent-a',
        root: './agent-a',
        card: 'agent.json',
        served: true,
        enabledModes: ['ask'],
        peers: ['agent-b']  // should peer with agent-b
      },
      {
        name: 'agent-b',
        root: './agent-b',
        card: 'agent.json',
        served: true,
        enabledModes: ['ask'],
        peers: []
      }
    ]
  };
  await writeManifest(meshRoot, manifest);

  // Write a stale registry for agent-a with NO peers (drifted)
  const staleRegistry = {
    'x-agentmesh-generated': true,
    peers: {}  // should have agent-b, but doesn't
  };
  await writeFile(
    join(meshRoot, 'agent-a', 'registry.json'),
    JSON.stringify(staleRegistry, null, 2) + '\n',
    'utf8'
  );

  const snapshot = await loadSnapshot(meshRoot);
  const report = checkConformance(snapshot);

  const wiringFail = report.rules.filter(r => r.rule === 'wiring' && r.level === 'fail');
  assert.ok(wiringFail.length > 0, 'wiring should fail: registry.json drifted from manifest');
  assert.ok(wiringFail.some(r => /differ/i.test(r.detail) || /drift/i.test(r.detail)));
  assert.equal(report.ok, false);
});

// ---------------------------------------------------------------------------
// Rule: Root containment
// ---------------------------------------------------------------------------

test('conformance root-containment: in-tree agent passes', async () => {
  const { meshRoot } = await makeSimpleMesh();
  const snapshot = await loadSnapshot(meshRoot);
  const report = checkConformance(snapshot);

  const containRules = report.rules.filter(r => r.rule === 'root-containment');
  assert.ok(containRules.length > 0, 'root-containment rule must be present');
  assert.ok(containRules.every(r => r.level === 'pass'), `root-containment: ${JSON.stringify(containRules)}`);
});

test('conformance root-containment: escaping root fails', async () => {
  const meshRoot = await mkdtemp(join(tmpdir(), 'conf-contain-'));
  await initMesh(meshRoot);

  // Create a manifest with a root that escapes (../outside)
  const manifest = {
    meshVersion: '0.1.0',
    agents: [
      {
        name: 'escapee',
        root: '../outside',  // escapes mesh root
        card: 'agent.json',
        served: false,
        enabledModes: [],
        peers: []
      }
    ]
  };
  // Write raw to bypass validateManifest (which would also catch this)
  const fs = await import('node:fs/promises');
  await fs.writeFile(join(meshRoot, 'mesh.json'), JSON.stringify({
    'x-agentmesh-generated': true,
    ...manifest
  }, null, 2), 'utf8');

  const snapshot = await loadSnapshot(meshRoot);
  const report = checkConformance(snapshot);

  // Either root-containment fails, or wiring warns (folder doesn't exist)
  // The important thing is it doesn't silently pass
  const containFail = report.rules.filter(r => r.rule === 'root-containment' && r.level === 'fail');
  const containWarn = report.rules.filter(r => r.rule === 'root-containment' && r.level === 'warn');
  assert.ok(
    containFail.length > 0 || containWarn.length > 0,
    'root-containment must flag an escaping root'
  );
});

// ---------------------------------------------------------------------------
// Rule: Standalone-runnable
// ---------------------------------------------------------------------------

test('conformance standalone: no requiredPeers passes', async () => {
  const { meshRoot } = await makeSimpleMesh();
  const snapshot = await loadSnapshot(meshRoot);
  const report = checkConformance(snapshot);

  const standaloneRules = report.rules.filter(r => r.rule === 'standalone-runnable');
  assert.ok(standaloneRules.length > 0, 'standalone-runnable rule must be present');
  assert.ok(standaloneRules.every(r => r.level === 'pass'), `standalone: ${JSON.stringify(standaloneRules)}`);
});

test('conformance standalone: non-empty requiredPeers fails', async () => {
  const { meshRoot, agentRoot } = await makeSimpleMesh();
  // Add requiredPeers to agent.json
  const agentJson = {
    ...minimalAgentJson('agent-a'),
    'x-agentmesh': {
      modes: ['ask'],
      meshVersion: CURRENT_MESH_VERSION,
      requiredPeers: ['some-peer']  // non-empty → fail
    }
  };
  await writeFile(join(agentRoot, 'agent.json'), JSON.stringify(agentJson, null, 2), 'utf8');

  const snapshot = await loadSnapshot(meshRoot);
  const report = checkConformance(snapshot);

  const standaloneFail = report.rules.filter(r => r.rule === 'standalone-runnable' && r.level === 'fail');
  assert.ok(standaloneFail.length > 0, 'standalone-runnable should fail with non-empty requiredPeers');
  assert.ok(standaloneFail.some(r => /requiredPeers/i.test(r.detail) || /some-peer/i.test(r.detail)));
  assert.equal(report.ok, false);
});

test('conformance standalone: unconditional delegate directive in system.md warns', async () => {
  const { meshRoot, agentRoot } = await makeSimpleMesh();
  // Add an unconditional peer directive to system.md
  await writeFile(
    join(agentRoot, 'prompts', 'system.md'),
    'You are an agent.\n\nYou must always delegate to the catalog peer.\n',
    'utf8'
  );

  const snapshot = await loadSnapshot(meshRoot);
  const report = checkConformance(snapshot);

  const standaloneWarn = report.rules.filter(r => r.rule === 'standalone-runnable' && r.level === 'warn');
  assert.ok(standaloneWarn.length > 0, 'standalone-runnable should warn on unconditional peer directive');
});

// ---------------------------------------------------------------------------
// Rule: enabledModes
// ---------------------------------------------------------------------------

test('conformance enabled-modes: valid subset passes', async () => {
  const { meshRoot } = await makeSimpleMesh('agent-a', ['ask']);
  const snapshot = await loadSnapshot(meshRoot);
  const report = checkConformance(snapshot);

  const modeRules = report.rules.filter(r => r.rule === 'enabled-modes');
  assert.ok(modeRules.every(r => r.level === 'pass'), `mode rules: ${JSON.stringify(modeRules)}`);
});

test('conformance enabled-modes: enabledModes ⊄ declared modes fails', async () => {
  const meshRoot = await mkdtemp(join(tmpdir(), 'conf-modes-'));
  await initMesh(meshRoot);
  // Agent declares only 'ask'
  await makeConformantAgent(meshRoot, 'agent-a', { modes: ['ask'] });

  const manifest = {
    meshVersion: '0.1.0',
    agents: [
      {
        name: 'agent-a',
        root: './agent-a',
        card: 'agent.json',
        served: true,
        enabledModes: ['ask', 'do'],  // 'do' not declared in agent.json
        peers: []
      }
    ]
  };
  await writeManifest(meshRoot, manifest);

  const snapshot = await loadSnapshot(meshRoot);
  const report = checkConformance(snapshot);

  const modeFail = report.rules.filter(r => r.rule === 'enabled-modes' && r.level === 'fail');
  assert.ok(modeFail.length > 0, 'enabled-modes should fail: do not declared in agent.json');
  assert.ok(modeFail.some(r => /do/i.test(r.detail)));
  assert.equal(report.ok, false);
});

test('conformance enabled-modes: served:true + empty enabledModes fails', async () => {
  const meshRoot = await mkdtemp(join(tmpdir(), 'conf-modes2-'));
  await initMesh(meshRoot);
  await makeConformantAgent(meshRoot, 'agent-a');

  const manifest = {
    meshVersion: '0.1.0',
    agents: [
      {
        name: 'agent-a',
        root: './agent-a',
        card: 'agent.json',
        served: true,
        enabledModes: [],  // empty — fail
        peers: []
      }
    ]
  };
  await writeManifest(meshRoot, manifest);

  const snapshot = await loadSnapshot(meshRoot);
  const report = checkConformance(snapshot);

  const modeFail = report.rules.filter(r => r.rule === 'enabled-modes' && r.level === 'fail');
  assert.ok(modeFail.length > 0, 'enabled-modes should fail: served+empty enabledModes');
  assert.ok(modeFail.some(r => /empty/i.test(r.detail) || /served/i.test(r.detail)));
  assert.equal(report.ok, false);
});

// ---------------------------------------------------------------------------
// Rule: Version
// ---------------------------------------------------------------------------

test('conformance version: current meshVersion passes', async () => {
  const { meshRoot } = await makeSimpleMesh();
  const snapshot = await loadSnapshot(meshRoot);
  const report = checkConformance(snapshot);

  const versionRules = report.rules.filter(r => r.rule === 'version');
  assert.ok(versionRules.every(r => r.level === 'pass'), `version rules: ${JSON.stringify(versionRules)}`);
});

test('conformance version: behind meshVersion warns', async () => {
  const { meshRoot, agentRoot } = await makeSimpleMesh();
  // Write an agent.json with an old meshVersion
  const agentJson = {
    ...minimalAgentJson('agent-a'),
    'x-agentmesh': {
      modes: ['ask'],
      meshVersion: '0.0.1'  // behind
    }
  };
  await writeFile(join(agentRoot, 'agent.json'), JSON.stringify(agentJson, null, 2), 'utf8');

  const snapshot = await loadSnapshot(meshRoot);
  const report = checkConformance(snapshot);

  const versionWarn = report.rules.filter(r => r.rule === 'version' && r.level === 'warn');
  assert.ok(versionWarn.length > 0, 'version should warn when meshVersion is behind');
  assert.ok(versionWarn.some(r => /0\.0\.1/i.test(r.detail) || /behind/i.test(r.detail) || /migratable/i.test(r.detail)));
  // warn doesn't make ok=false
  const fails = report.rules.filter(r => r.level === 'fail');
  // (there may be zero fails — version warn alone doesn't fail)
  assert.ok(report.ok || fails.length > 0, 'if no other fails, report.ok should be true');
});

test('conformance version: missing meshVersion warns', async () => {
  const { meshRoot, agentRoot } = await makeSimpleMesh();
  const agentJson = {
    name: 'agent-a',
    protocolVersion: '1.0',
    version: '0.1.0',
    skills: [],
    'x-agentmesh': {
      modes: ['ask']
      // meshVersion intentionally absent
    }
  };
  await writeFile(join(agentRoot, 'agent.json'), JSON.stringify(agentJson, null, 2), 'utf8');

  const snapshot = await loadSnapshot(meshRoot);
  const report = checkConformance(snapshot);

  const versionWarn = report.rules.filter(r => r.rule === 'version' && r.level === 'warn');
  assert.ok(versionWarn.length > 0, 'version should warn when meshVersion is absent');
});

// ---------------------------------------------------------------------------
// Integration: clean mesh passes all rules
// ---------------------------------------------------------------------------

test('conformance: a fully conformant mesh passes all rules', async () => {
  const { meshRoot } = await makeSimpleMesh('agent-a', ['ask']);
  const snapshot = await loadSnapshot(meshRoot);
  const report = checkConformance(snapshot);

  const fails = report.rules.filter(r => r.level === 'fail');
  assert.deepEqual(fails, [], `Expected no failures, got: ${JSON.stringify(fails)}`);
  assert.equal(report.ok, true);
});
