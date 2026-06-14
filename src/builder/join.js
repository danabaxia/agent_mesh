/**
 * src/builder/join.js
 *
 * join(meshRoot, nameOrFolder) — in-place join (rejoin-after-leave).
 *
 * Unlike `add`, join does NOT copy anything. It is for a folder that is
 * already in-tree (its canonical path resolves inside <meshRoot>/<name>).
 *
 * - If the folder IS in-tree: re-register its manifest entry (default
 *   {served:true, enabledModes:['ask'], peers:[]}) and regenerate wiring.
 *   No collision/--force error on rejoin.
 * - If the folder is NOT in-tree: refuse and tell the caller to use `add`.
 *
 * Rules (§7):
 *   - Existing Authored (markerless) registry.json → not overwritten; report it.
 *   - Managed (marker present) registry.json → regenerated.
 *
 * Returns:
 *  {
 *    name:                string,
 *    manifestEntry:       object,
 *    registriesRegenerated: string[],
 *    registriesUntouched:   string[],
 *    warnings:              string[]
 *  }
 */

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join as pathJoin, resolve, basename, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readManifest, writeManifest, validateManifest, generateRegistry
} from './manifest.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BIN_PATH = resolve(__dirname, '../../bin/agent-mesh.js');

// ---------------------------------------------------------------------------
// Marker helper (shared pattern across builder modules)
// ---------------------------------------------------------------------------

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
 * Register an already-in-tree agent (rejoin).
 *
 * @param {string} meshRoot      absolute path to the mesh root
 * @param {string} nameOrFolder  agent name (simple) OR absolute path to in-tree folder
 * @param {object} [opts]
 *   @param {string[]} [opts.modes]  enabled modes (defaults to ['ask'])
 * @returns {Promise<object>}  structured result
 */
export async function join(meshRoot, nameOrFolder, opts = {}) {
  const { modes = ['ask'] } = opts;

  // ── Determine the agent name and its expected in-tree path ────────────────
  //
  // nameOrFolder may be:
  //   a) a simple name like "my-agent"  → in-tree path = <meshRoot>/<name>
  //   b) an absolute path               → we compute name = basename; check containment
  //   c) a relative path                → resolve to absolute first

  let name;
  let inTreePath; // expected canonical path inside the mesh root

  const isAbsOrRel = nameOrFolder.startsWith('/') || nameOrFolder.startsWith('.') ||
                     nameOrFolder.includes('/');

  if (isAbsOrRel) {
    // Treat as a folder path
    const candidate = resolve(nameOrFolder);
    name = basename(candidate);
    inTreePath = pathJoin(meshRoot, name);

    // Check containment: the candidate must equal the in-tree path
    // (we don't realpath here because the folder may not exist yet after a leave;
    //  string-equality on the resolved path is the right check per §7)
    const normalizedCandidate = normalize(candidate);
    const normalizedInTree = normalize(inTreePath);

    if (normalizedCandidate !== normalizedInTree) {
      throw new Error(
        `"${nameOrFolder}" is not an in-tree path (expected "${inTreePath}" under mesh root "${meshRoot}"). ` +
        `Use "add" to copy an external folder into the mesh first.`
      );
    }
  } else {
    // Simple name
    name = nameOrFolder;
    inTreePath = pathJoin(meshRoot, name);
  }

  // Verify the in-tree path exists
  try {
    await access(inTreePath);
  } catch {
    throw new Error(
      `Agent folder "${inTreePath}" does not exist inside the mesh root. ` +
      `Use "add" to copy an external folder into the mesh first.`
    );
  }

  // ── Try to detect supported modes from agent.json ─────────────────────────
  let enabledModes = modes;
  try {
    const agentJsonPath = pathJoin(inTreePath, 'agent.json');
    const raw = JSON.parse(await readFile(agentJsonPath, 'utf8'));
    const declared = raw['x-agentmesh']?.modes;
    if (Array.isArray(declared) && declared.length > 0) {
      // Use declared modes if caller didn't explicitly pass modes override
      // (default ['ask'] is the fallback when nothing is detected)
      enabledModes = modes; // Caller has final say; we leave detection as a hint only
    }
  } catch { /* absent or unparseable — use default */ }

  // ── Build manifest entry ───────────────────────────────────────────────────
  const manifestEntry = {
    name,
    root: `./${name}`,
    card: 'agent.json',
    served: true,
    enabledModes,
    peers: []
  };

  // ── Read and upsert manifest ───────────────────────────────────────────────
  const manifest = await readManifest(meshRoot);
  const existingIdx = manifest.agents.findIndex(a => a.name === name);
  if (existingIdx >= 0) {
    // Rejoin: update in place, preserving existing peers if present
    const existing = manifest.agents[existingIdx];
    manifest.agents[existingIdx] = {
      ...manifestEntry,
      peers: existing.peers || []
    };
  } else {
    manifest.agents.push(manifestEntry);
  }

  // Validate before writing
  const { ok, errors } = validateManifest(manifest);
  if (!ok) {
    throw new Error(
      `Manifest would be invalid after join of "${name}": ${errors.join('; ')}`
    );
  }
  await writeManifest(meshRoot, manifest);

  // ── Regenerate registries for all agents ──────────────────────────────────
  const warnings = [];
  const registriesRegenerated = [];
  const registriesUntouched = [];

  const registries = generateRegistry(manifest, {
    meshRootAbs: meshRoot,
    binPath: BIN_PATH
  });

  for (const [agentName, registry] of Object.entries(registries)) {
    const agentEntry = manifest.agents.find(a => a.name === agentName);
    if (!agentEntry) continue;

    const agentRoot = pathJoin(meshRoot, agentEntry.root);
    const registryPath = pathJoin(agentRoot, 'registry.json');

    const marker = await readRegistryMarker(registryPath);
    if (marker === false) {
      // Authored — refuse to overwrite; warn
      warnings.push(
        `Agent "${agentName}" has an Authored (markerless) registry.json at ` +
        `"${registryPath}" — not regenerated. The agent will remain standalone ` +
        `until the registry is manually removed or replaced.`
      );
      registriesUntouched.push(registryPath);
      continue;
    }

    // Managed (true) or absent (null) — write
    await mkdir(agentRoot, { recursive: true });
    await writeFile(registryPath, JSON.stringify(registry, null, 2) + '\n', 'utf8');
    registriesRegenerated.push(registryPath);
  }

  return {
    name,
    manifestEntry: manifest.agents.find(a => a.name === name),
    registriesRegenerated,
    registriesUntouched,
    warnings
  };
}
