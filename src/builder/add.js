/**
 * src/builder/add.js
 *
 * Orchestrator for the `add` converter — discover → place → scaffold →
 * register → wire (→ validate in a future increment).
 *
 * By default (`apply: false`) the function performs a DRY-RUN: builds and
 * returns the full plan without touching disk.
 *
 * With `apply: true` it executes: copy-in, scaffold gap files, upsert the
 * agent entry in mesh.json, regenerate affected registry.json files.
 *
 * Security / ownership invariants enforced here:
 *  - Agent-root containment: dest must resolve inside meshRoot.
 *  - registry.json refusal: a markerless (Authored) registry.json is never
 *    overwritten silently; we throw instead.
 *  - Non-clobber of seeded files: scaffold.js only returns gaps for absent
 *    files; we only write those.
 */

import { readFile, writeFile, mkdir, access, readdir, stat } from 'node:fs/promises';
import { join, basename, resolve, relative } from 'node:path';
import { discoverAgentStructure } from '../agent-context.js';
import { isPathInsideRoot } from '../path-guard.js';
import { scaffoldGaps } from './scaffold.js';
import { copyInto } from './migrate.js';
import {
  readManifest, writeManifest, validateManifest, generateRegistry
} from './manifest.js';
import { proposePatch } from './propose.js';

// The bin path used when generating registry spawn args.
// We locate bin/agent-mesh.js relative to this file (src/builder/add.js → ../../bin/agent-mesh.js).
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BIN_PATH = resolve(__dirname, '../../bin/agent-mesh.js');

// ---------------------------------------------------------------------------
// Discover extra builder fields not returned by discoverAgentStructure
// ---------------------------------------------------------------------------

/**
 * Extend a discoverAgentStructure() result with builder-extra fields.
 * These are needed by scaffoldGaps() but are not part of the runtime structure.
 *
 * @param {string} agentFolder  absolute path to the agent folder
 * @param {object} structure    discoverAgentStructure() result
 * @returns {object}  extended structure
 */
async function extendStructure(agentFolder, structure) {
  // agent.json
  const agentJsonPath = join(agentFolder, 'agent.json');
  let agentJson = null;
  try { await access(agentJsonPath); agentJson = agentJsonPath; } catch { /* absent */ }

  // AGENT.md
  const agentMdPath = join(agentFolder, 'AGENT.md');
  let agentMd = null;
  try { await access(agentMdPath); agentMd = agentMdPath; } catch { /* absent */ }

  // .mcp.json
  const mcpJsonPath = join(agentFolder, '.mcp.json');
  let mcpJson = null;
  try { await access(mcpJsonPath); mcpJson = mcpJsonPath; } catch { /* absent */ }

  // tools/*/server.mjs
  const toolServers = await discoverToolServers(agentFolder);

  return { ...structure, agentJson, agentMd, mcpJson, toolServers };
}

async function discoverToolServers(agentFolder) {
  const toolsDir = join(agentFolder, 'tools');
  const servers = [];
  let entries;
  try {
    entries = await readdir(toolsDir, { withFileTypes: true });
  } catch {
    return servers;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const serverPath = join(toolsDir, entry.name, 'server.mjs');
    try {
      await access(serverPath);
      servers.push(`tools/${entry.name}/server.mjs`);
    } catch { /* not present */ }
  }
  return servers;
}

// ---------------------------------------------------------------------------
// Marker check helpers
// ---------------------------------------------------------------------------

async function readRegistryMarker(registryPath) {
  try {
    const raw = JSON.parse(await readFile(registryPath, 'utf8'));
    return raw['x-agentmesh-generated'] === true;
  } catch {
    return null; // absent or unparseable
  }
}

// ---------------------------------------------------------------------------
// Proposed-patch helpers
// ---------------------------------------------------------------------------

/**
 * Inspect a dest agent.json and return a proposed content string if it is
 * "existing-but-partial" (missing x-agentmesh.modes or x-agentmesh.meshVersion).
 * Returns null if the file is absent, fully valid, or unreadable.
 *
 * @param {string} agentJsonPath  absolute path to the dest agent.json
 * @param {object} identity       { name, modes, role? }
 * @returns {Promise<string|null>}  proposed JSON content, or null if no patch needed
 */
async function buildAgentJsonProposal(agentJsonPath, identity) {
  let raw;
  try {
    raw = JSON.parse(await readFile(agentJsonPath, 'utf8'));
  } catch {
    return null; // absent or unparseable — not partial, skip
  }

  const xam = raw['x-agentmesh'];
  const missingModes = !xam || !Array.isArray(xam.modes) || xam.modes.length === 0;
  const missingVersion = !xam || typeof xam.meshVersion !== 'string';

  if (!missingModes && !missingVersion) {
    return null; // fully valid — no patch needed
  }

  // Build a proposed merged version
  const proposed = {
    ...raw,
    'x-agentmesh': {
      ...(typeof xam === 'object' && xam !== null ? xam : {}),
      ...(missingModes ? { modes: identity.modes || ['ask'] } : {}),
      ...(missingVersion ? { meshVersion: '0.1.0' } : {})
    }
  };
  return JSON.stringify(proposed, null, 2) + '\n';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Add an agent folder to a mesh.
 *
 * @param {string} meshRoot      absolute path to the mesh root
 * @param {string} agentFolder   absolute path to the source agent folder
 * @param {object} opts
 *   @param {string}   [opts.name]    agent name (defaults to basename of agentFolder)
 *   @param {string[]} [opts.modes]   enabled modes (defaults to ['ask'])
 *   @param {string}   [opts.role]    one-line role description
 *   @param {boolean}  [opts.apply]   true to execute; false (default) = dry-run
 *   @param {boolean}  [opts.force]   allow non-empty dest (copyInto collision)
 * @returns {Promise<object>}  plan (dry-run) or result (apply)
 */
export async function add(meshRoot, agentFolder, opts = {}) {
  const {
    name: nameOpt,
    modes = ['ask'],
    role,
    apply = false,
    force = false
  } = opts;

  // 1. Determine name and dest
  const name = nameOpt || basename(agentFolder);
  const dest = join(meshRoot, name);

  // 2. Agent-root containment check
  const inside = await isPathInsideRoot(meshRoot, dest);
  if (!inside) {
    throw new Error(
      `Agent root containment violation: destination "${dest}" is not inside mesh root "${meshRoot}". ` +
      `The dest must resolve inside the mesh root.`
    );
  }

  // 3. Discover structure of source folder
  const rawStructure = await discoverAgentStructure(agentFolder);
  const structure = await extendStructure(agentFolder, rawStructure);

  // 4. Build scaffold gaps (relative to agentFolder — or dest for apply)
  const identity = { name, role, modes };
  // When applying, scaffold relative to dest; the gaps are based on what's in
  // the source now (before copy). After copy we check the dest for existing files.
  const scaffoldList = scaffoldGaps(structure, identity);

  // 5. Build manifest entry
  const manifestEntry = {
    name,
    root: `./${name}`,
    card: 'agent.json',
    served: true,
    enabledModes: modes,
    peers: []
  };

  if (!apply) {
    // DRY-RUN: return the plan, touch nothing
    return {
      dryRun: true,
      dest,
      scaffold: scaffoldList,
      manifestEntry,
      registryChanges: [`${name}/registry.json`]
    };
  }

  // -------------------------------------------------------------------------
  // APPLY
  // -------------------------------------------------------------------------

  // 6. Copy source into mesh root (migration policy)
  const { copied, skipped } = await copyInto(agentFolder, dest, { force });

  // 7. After copy, re-discover structure at dest (respects already-copied files)
  const destRawStructure = await discoverAgentStructure(dest);
  const destStructure = await extendStructure(dest, destRawStructure);
  const destScaffoldList = scaffoldGaps(destStructure, identity);

  // 8. Check registry.json in dest — refuse if markerless (Authored)
  const destRegistryPath = join(dest, 'registry.json');
  const registryMarker = await readRegistryMarker(destRegistryPath);
  if (registryMarker === false) {
    // Exists but no marker — Authored, refuse
    throw new Error(
      `Refusing to overwrite "${destRegistryPath}": the existing registry.json has no x-agentmesh-generated marker ` +
      `(it is Authored). Remove or back it up manually, then re-run with --apply.`
    );
  }

  // 9. Write scaffold gap files into dest.
  //    For existing-but-partial Seeded files (agent.json), emit a *.proposed
  //    patch rather than editing in place.
  const createdFiles = [];
  const proposedFiles = [];

  // Check for existing-but-partial agent.json BEFORE writing gaps
  const destAgentJsonPath = join(dest, 'agent.json');
  const agentJsonProposal = await buildAgentJsonProposal(destAgentJsonPath, identity);
  if (agentJsonProposal !== null) {
    const proposedFilePath = await proposePatch(destAgentJsonPath, agentJsonProposal);
    proposedFiles.push(proposedFilePath);
  }

  for (const { path: relPath, content } of destScaffoldList) {
    const absPath = join(dest, relPath);
    await mkdir(join(absPath, '..'), { recursive: true });
    await writeFile(absPath, content, 'utf8');
    createdFiles.push(absPath);
  }

  // 10. Upsert manifest entry in mesh.json
  const manifest = await readManifest(meshRoot);
  const existingIdx = manifest.agents.findIndex(a => a.name === name);
  if (existingIdx >= 0) {
    manifest.agents[existingIdx] = manifestEntry;
  } else {
    manifest.agents.push(manifestEntry);
  }

  // Validate before writing
  const { ok, errors } = validateManifest(manifest);
  if (!ok) {
    throw new Error(`Generated manifest would be invalid: ${errors.join('; ')}`);
  }
  await writeManifest(meshRoot, manifest);

  // 11. Regenerate registry.json for every agent
  const registries = generateRegistry(manifest, { meshRootAbs: meshRoot, binPath: BIN_PATH });
  const registryFiles = [];
  for (const [agentName, registry] of Object.entries(registries)) {
    const agentEntry = manifest.agents.find(a => a.name === agentName);
    if (!agentEntry) continue;
    const agentRoot = join(meshRoot, agentEntry.root);
    const registryPath = join(agentRoot, 'registry.json');

    // Check: if a registry.json exists at this path and is Authored, refuse
    const existingMarker = await readRegistryMarker(registryPath);
    if (existingMarker === false) {
      // Authored — refuse to overwrite
      throw new Error(
        `Refusing to overwrite "${registryPath}": existing registry.json has no x-agentmesh-generated marker. ` +
        `Back it up and remove it manually, then re-run.`
      );
    }

    // Write the managed registry.json
    await mkdir(agentRoot, { recursive: true });
    await writeFile(registryPath, JSON.stringify(registry, null, 2) + '\n', 'utf8');
    registryFiles.push(registryPath);
  }

  return {
    dryRun: false,
    dest,
    manifestEntry,
    createdFiles,
    proposedFiles,
    registryFiles,
    copied,
    skipped,
    warnings: []
  };
}
