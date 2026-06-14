/**
 * test/validate-cli.test.js
 *
 * Tests for the `validate` and `doctor` CLI commands.
 * Verifies that `validate` exits non-zero on a failing mesh.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp, writeFile, mkdir, rm
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { initMesh } from '../src/builder/init-mesh.js';
import { writeManifest, generateRegistry } from '../src/builder/manifest.js';
import { CURRENT_MESH_VERSION } from '../src/builder/conformance.js';
import { CANONICAL_DIRS } from '../src/builder/scaffold.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function minimalAgentJson(name = 'agent-a', modes = ['ask']) {
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

async function makeConformantMesh(agentName = 'agent-a') {
  const meshRoot = await mkdtemp(join(tmpdir(), 'valcli-'));
  await initMesh(meshRoot);

  const agentRoot = join(meshRoot, agentName);
  await mkdir(join(agentRoot, 'prompts'), { recursive: true });
  await writeFile(
    join(agentRoot, 'agent.json'),
    JSON.stringify(minimalAgentJson(agentName), null, 2),
    'utf8'
  );
  await writeFile(
    join(agentRoot, 'prompts', 'system.md'),
    `# ${agentName}\nYou are ${agentName}.`,
    'utf8'
  );
  // Canonical directory structure (spec 2026-06-10 §4)
  for (const dir of CANONICAL_DIRS) {
    await mkdir(join(agentRoot, dir), { recursive: true });
  }

  const manifest = {
    meshVersion: '0.1.0',
    agents: [
      {
        name: agentName,
        root: `./${agentName}`,
        card: 'agent.json',
        served: true,
        enabledModes: ['ask'],
        peers: []
      }
    ]
  };
  await writeManifest(meshRoot, manifest);

  // Write matching registry.json
  const registries = generateRegistry(manifest, {
    meshRootAbs: meshRoot,
    binPath: '/bin/agent-mesh.js'
  });
  await writeFile(
    join(agentRoot, 'registry.json'),
    JSON.stringify(registries[agentName], null, 2) + '\n',
    'utf8'
  );

  return { meshRoot, agentRoot };
}

// Capture process.exitCode behavior
function withExitCode(fn) {
  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  return fn().then(() => {
    const code = process.exitCode;
    process.exitCode = origExitCode;
    return code;
  }).catch(err => {
    process.exitCode = origExitCode;
    throw err;
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('validate CLI: conformant mesh exits with code 0 (undefined)', async () => {
  const { meshRoot } = await makeConformantMesh();

  const exitCode = await withExitCode(() =>
    main(['validate', meshRoot], {})
  );

  // exitCode should be undefined or 0 (no failures)
  assert.ok(
    exitCode === undefined || exitCode === 0,
    `Expected exit code 0/undefined for conformant mesh, got: ${exitCode}`
  );
});

test('validate CLI: failing mesh exits non-zero', async () => {
  const { meshRoot, agentRoot } = await makeConformantMesh();

  // Break conformance: remove prompts/system.md
  await rm(join(agentRoot, 'prompts', 'system.md'));

  const exitCode = await withExitCode(() =>
    main(['validate', meshRoot], {})
  );

  assert.ok(
    exitCode !== undefined && exitCode !== 0,
    `Expected non-zero exit code for failing mesh, got: ${exitCode}`
  );
});

test('validate CLI: missing mesh.json exits with error', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'valcli-empty-'));
  // No mesh.json

  const exitCode = await withExitCode(() =>
    main(['validate', tmp], {})
  );

  // Should exit non-zero (either 1 from error or 1 from failed conformance)
  assert.ok(
    exitCode !== undefined && exitCode !== 0,
    `Expected non-zero for missing mesh.json, got: ${exitCode}`
  );
});

test('validate CLI: missing mesh-root arg shows usage and exits 2', async () => {
  const exitCode = await withExitCode(() =>
    main(['validate'], {})
  );

  assert.equal(exitCode, 2, 'validate with no args must exit 2');
});

test('doctor CLI: dry-run succeeds on conformant mesh', async () => {
  const { meshRoot } = await makeConformantMesh();

  const exitCode = await withExitCode(() =>
    main(['doctor', meshRoot], {})
  );

  assert.ok(
    exitCode === undefined || exitCode === 0,
    `Expected exit code 0/undefined for doctor dry-run, got: ${exitCode}`
  );
});

test('doctor CLI: missing mesh-root arg shows usage and exits 2', async () => {
  const exitCode = await withExitCode(() =>
    main(['doctor'], {})
  );

  assert.equal(exitCode, 2, 'doctor with no args must exit 2');
});
