/**
 * src/builder/leave.js
 *
 * leave(meshRoot, name) — remove an agent from the mesh, atomically:
 *
 *  1. Remove the agent's entry from mesh.json agents[].
 *  2. Prune the departed name from every remaining agent's peers[].
 *  3. For the departing agent's own registry.json:
 *       marker present (Managed)  → delete the whole file
 *       marker absent  (Authored) → leave untouched, report it
 *  4. Regenerate every other affected agent's managed registry.json from
 *     the updated manifest. Skip (warn) any markerless (Authored) one.
 *
 * The departing agent's identity/tools/memory/code are never touched.
 *
 * Returns a structured result:
 *  {
 *    removed:          <the removed manifest entry>,
 *    prunedFrom:       string[]  — agent names that had the departed peer removed,
 *    registriesRegenerated: string[] — registry.json paths rewritten,
 *    registriesUntouched:   string[] — authored registry.json paths left alone,
 *    warnings:         string[]
 *  }
 */

import { unlink, writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  readManifest, writeManifest, validateManifest, generateRegistry
} from './manifest.js';

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BIN_PATH = resolve(__dirname, '../../bin/agent-mesh.js');

// ---------------------------------------------------------------------------
// Marker helper
// ---------------------------------------------------------------------------

/**
 * Returns:
 *   true   — file exists and has x-agentmesh-generated: true
 *   false  — file exists but has no marker (Authored)
 *   null   — file absent or unreadable
 */
async function readRegistryMarker(registryPath) {
  try {
    const raw = JSON.parse(await readFile(registryPath, 'utf8'));
    return raw['x-agentmesh-generated'] === true;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Remove an agent from the mesh.
 *
 * @param {string} meshRoot  absolute path to the mesh root
 * @param {string} name      name of the agent to remove (must match manifest)
 * @returns {Promise<object>}  structured result
 */
export async function leave(meshRoot, name) {
  // ── 1. Read manifest ───────────────────────────────────────────────────────
  const manifest = await readManifest(meshRoot);

  const entryIndex = manifest.agents.findIndex(a => a.name === name);
  if (entryIndex === -1) {
    throw new Error(
      `Agent "${name}" not found in mesh.json at "${meshRoot}". ` +
      `Available agents: ${manifest.agents.map(a => a.name).join(', ') || '(none)'}`
    );
  }

  const removed = manifest.agents[entryIndex];

  // ── 2. Remove entry + prune peers atomically ───────────────────────────────
  manifest.agents.splice(entryIndex, 1);

  const prunedFrom = [];
  for (const agent of manifest.agents) {
    if (Array.isArray(agent.peers) && agent.peers.includes(name)) {
      agent.peers = agent.peers.filter(p => p !== name);
      prunedFrom.push(agent.name);
    }
  }

  // Validate the pruned manifest before writing
  const { ok, errors } = validateManifest(manifest);
  if (!ok) {
    throw new Error(
      `Manifest would be invalid after removing "${name}": ${errors.join('; ')}`
    );
  }
  await writeManifest(meshRoot, manifest);

  // ── 3. Handle departing agent's own registry.json ─────────────────────────
  const departingRoot = join(meshRoot, removed.root);
  const departingRegistryPath = join(departingRoot, 'registry.json');
  const warnings = [];

  const departingMarker = await readRegistryMarker(departingRegistryPath);
  if (departingMarker === true) {
    // Managed — delete whole file
    try {
      await unlink(departingRegistryPath);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err; // absent is fine
    }
  } else if (departingMarker === false) {
    // Authored — leave untouched, report
    warnings.push(
      `Departing agent "${name}" has an Authored (markerless) registry.json at ` +
      `"${departingRegistryPath}" — left untouched.`
    );
  }
  // null (absent) — nothing to do

  // ── 4. Regenerate every remaining agent's managed registry.json ───────────
  const registriesRegenerated = [];
  const registriesUntouched = [];

  if (manifest.agents.length > 0) {
    const registries = generateRegistry(manifest, {
      meshRootAbs: meshRoot,
      binPath: BIN_PATH
    });

    for (const [agentName, registry] of Object.entries(registries)) {
      const agentEntry = manifest.agents.find(a => a.name === agentName);
      if (!agentEntry) continue;

      const agentRoot = join(meshRoot, agentEntry.root);
      const registryPath = join(agentRoot, 'registry.json');

      const marker = await readRegistryMarker(registryPath);
      if (marker === false) {
        // Authored — refuse to overwrite, warn
        warnings.push(
          `Agent "${agentName}" has an Authored (markerless) registry.json at ` +
          `"${registryPath}" — not regenerated. Remove stale peer "${name}" manually.`
        );
        registriesUntouched.push(registryPath);
        continue;
      }

      // Managed (true) or absent (null) — write
      await mkdir(agentRoot, { recursive: true });
      await writeFile(registryPath, JSON.stringify(registry, null, 2) + '\n', 'utf8');
      registriesRegenerated.push(registryPath);
    }
  }

  return {
    removed,
    prunedFrom,
    registriesRegenerated,
    registriesUntouched,
    warnings
  };
}
