/**
 * src/builder/manifest.js
 *
 * Read/validate/write mesh.json (the manifest — authoring source of truth).
 * Generate per-agent registry.json objects from the manifest.
 *
 * Purity split:
 *   validateManifest()  — pure
 *   generateRegistry()  — pure
 *   readManifest()      — thin I/O (read + parse)
 *   writeManifest()     — thin I/O (serialise + write)
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join, normalize, isAbsolute } from 'node:path';

const MESH_JSON = 'mesh.json';

// ---------------------------------------------------------------------------
// validateManifest — pure
// ---------------------------------------------------------------------------

/**
 * Validate a parsed manifest object.
 * @param {object} manifest
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateManifest(manifest) {
  const errors = [];

  if (typeof manifest !== 'object' || manifest === null) {
    return { ok: false, errors: ['manifest must be an object'] };
  }

  // top-level required fields
  if (typeof manifest.meshVersion !== 'string' || !manifest.meshVersion) {
    errors.push('meshVersion (string) is required');
  }
  if (!Array.isArray(manifest.agents)) {
    errors.push('agents (array) is required');
    return { ok: false, errors };
  }

  // per-agent validation — collect all, then cross-validate
  const agentNames = new Map(); // name → index

  for (let i = 0; i < manifest.agents.length; i++) {
    const agent = manifest.agents[i];
    const prefix = `agents[${i}]`;

    if (typeof agent.name !== 'string' || !agent.name) {
      errors.push(`${prefix}: name (string) is required`);
    } else {
      if (agentNames.has(agent.name)) {
        errors.push(`duplicate agent name "${agent.name}"`);
      } else {
        agentNames.set(agent.name, i);
      }
    }

    // root must be a non-empty string, not absolute, and normalized must not start with '..'
    if (typeof agent.root !== 'string' || !agent.root) {
      errors.push(`${prefix}: root (string) is required`);
    } else if (isAbsolute(agent.root)) {
      errors.push(`${prefix}: root must be a mesh-relative path, not absolute ("${agent.root}")`);
    } else {
      const norm = normalize(agent.root);
      if (norm === '..' || norm.startsWith('..'+'/') || norm.startsWith('..\\'+'')) {
        errors.push(`${prefix}: root must not escape the mesh (normalized: "${norm}")`);
      }
    }

    if (typeof agent.card !== 'string' || !agent.card) {
      errors.push(`${prefix}: card (string) is required`);
    }

    if (typeof agent.served !== 'boolean') {
      errors.push(`${prefix}: served (boolean) is required`);
    }

    if (!Array.isArray(agent.enabledModes)) {
      errors.push(`${prefix}: enabledModes (array of strings) is required`);
    } else {
      if (agent.served === true && agent.enabledModes.length === 0) {
        errors.push(
          `${prefix} ("${agent.name}"): served:true requires at least one enabledModes entry`
        );
      }
      for (const m of agent.enabledModes) {
        if (typeof m !== 'string') {
          errors.push(`${prefix}: enabledModes entries must be strings`);
          break;
        }
      }
    }

    // `skills` is OPTIONAL (per-agent skill allowlist). Absent → all discovered
    // skills allowed (the bug-fix default); [] → skills disabled; [names] → only
    // those. When present it must be an array of strings.
    if (agent.skills !== undefined) {
      if (!Array.isArray(agent.skills)) {
        errors.push(`${prefix}: skills (array of strings) must be an array when present`);
      } else {
        for (const s of agent.skills) {
          if (typeof s !== 'string') {
            errors.push(`${prefix}: skills entries must be strings`);
            break;
          }
        }
      }
    }

    if (!Array.isArray(agent.peers)) {
      errors.push(`${prefix}: peers (array of strings) is required`);
    } else {
      for (const p of agent.peers) {
        if (typeof p !== 'string') {
          errors.push(`${prefix}: peers entries must be strings`);
          break;
        }
      }
    }
  }

  // live-edge peer validation: every peer must reference an existing agent with served:true
  for (let i = 0; i < manifest.agents.length; i++) {
    const agent = manifest.agents[i];
    if (!Array.isArray(agent.peers)) continue;
    for (const peerName of agent.peers) {
      if (!agentNames.has(peerName)) {
        errors.push(
          `agents[${i}] ("${agent.name}"): peer "${peerName}" does not reference any agent in the manifest`
        );
      } else {
        const peerIndex = agentNames.get(peerName);
        const peer = manifest.agents[peerIndex];
        if (peer.served !== true) {
          errors.push(
            `agents[${i}] ("${agent.name}"): peer "${peerName}" is not served (served:false) — live edges must point to served agents`
          );
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// generateRegistry — pure
// ---------------------------------------------------------------------------

/**
 * Generate per-agent registry.json objects from the manifest.
 *
 * @param {object} manifest  - parsed mesh.json
 * @param {{ meshRootAbs: string, binPath: string }} opts
 * @returns {{ [agentName: string]: object }}
 */
export function generateRegistry(manifest, { meshRootAbs, binPath }) {
  // Build a lookup: name → agent entry
  const agentByName = new Map();
  for (const agent of manifest.agents) {
    agentByName.set(agent.name, agent);
  }

  const result = {};

  for (const agent of manifest.agents) {
    const peers = {};

    for (const peerName of (agent.peers || [])) {
      const peer = agentByName.get(peerName);
      if (!peer) continue; // validation already catches this; skip defensively

      const absRoot = join(meshRootAbs, peer.root);
      peers[peerName] = {
        root: absRoot,
        command: 'node',
        args: [binPath, 'serve-a2a', absRoot],
        cwd: absRoot,
        env: {
          AGENT_MESH_ENABLED_MODES: (peer.enabledModes || []).join(','),
          AGENT_MESH_MESH_ROOT: join(meshRootAbs, 'mesh'),
          AGENT_MESH_MESH_CEILING: meshRootAbs
        }
      };
    }

    result[agent.name] = {
      'x-agentmesh-generated': true,
      peers
    };
  }

  return result;
}

// ---------------------------------------------------------------------------
// readManifest — thin I/O
// ---------------------------------------------------------------------------

/**
 * Read and parse <meshRoot>/mesh.json.
 * @param {string} meshRoot  absolute path to the mesh root directory
 * @returns {Promise<object>}
 */
export async function readManifest(meshRoot) {
  const filePath = join(meshRoot, MESH_JSON);
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`mesh.json not found at ${filePath}`);
    }
    throw err;
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`mesh.json at ${filePath} contains invalid JSON: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// writeManifest — thin I/O
// ---------------------------------------------------------------------------

/**
 * Write <meshRoot>/mesh.json with 2-space indentation.
 * Ensures top-level x-agentmesh-generated:true and meshVersion are present.
 *
 * @param {string} meshRoot  absolute path to the mesh root directory
 * @param {object} manifest
 * @returns {Promise<void>}
 */
export async function writeManifest(meshRoot, manifest) {
  const enriched = {
    'x-agentmesh-generated': true,
    meshVersion: manifest.meshVersion,
    ...manifest
  };
  // Ensure the marker is always at the top and meshVersion is present
  enriched['x-agentmesh-generated'] = true;
  if (manifest.meshVersion !== undefined) {
    enriched.meshVersion = manifest.meshVersion;
  }

  const filePath = join(meshRoot, MESH_JSON);
  await writeFile(filePath, JSON.stringify(enriched, null, 2) + '\n', 'utf8');
}
