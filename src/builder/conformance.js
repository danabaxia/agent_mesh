/**
 * src/builder/conformance.js
 *
 * Conformance checker for agent mesh onboarding (Inc 3a).
 *
 * Purity split:
 *   loadSnapshot()     — thin I/O: reads files, lists dirs, returns a plain object
 *   checkConformance() — PURE: takes a snapshot, returns a report (no I/O, no async)
 *
 * Rule-set (§6 of the design spec):
 *   - anatomy          : required files present (agent.json, prompts/system.md)
 *   - tools            : every tools/<x>/server.mjs declared in .mcp.json; no dangling decls
 *   - card             : agent.json parses + buildAgentCard succeeds
 *   - wiring           : registry.json peers match generateRegistry output; peers are live edges
 *   - root-containment : every agents[].root realpath resolves inside meshRoot
 *   - standalone-runnable: fail if non-empty requiredPeers; warn on unconditional peer directives
 *   - enabled-modes    : enabledModes ⊆ agent.json x-agentmesh.modes; served:true ⇒ non-empty
 *   - version          : compare x-agentmesh.meshVersion to current standard "0.1.0"
 */

import { readFile, readdir, access, realpath } from 'node:fs/promises';
import { join, relative, sep, isAbsolute } from 'node:path';
import { discoverAgentStructure } from '../agent-context.js';
import { buildAgentCard } from '../a2a/protocol.js';
import { generateRegistry } from './manifest.js';
import { CANONICAL_DIRS } from './scaffold.js';

export const CURRENT_MESH_VERSION = '0.1.0';

// ---------------------------------------------------------------------------
// loadSnapshot — thin I/O
// ---------------------------------------------------------------------------

/**
 * Load a snapshot of one agent (or all agents in a mesh) for conformance checking.
 *
 * @param {string} meshRoot    absolute path to the mesh root directory
 * @param {object} [opts]
 *   @param {string} [opts.agentName]  if set, load only this agent; otherwise whole mesh
 * @returns {Promise<object>} snapshot — plain data object, no methods
 */
export async function loadSnapshot(meshRoot, { agentName } = {}) {
  // Canonicalize meshRoot
  let meshRootCanonical = meshRoot;
  try {
    meshRootCanonical = await realpath(meshRoot);
  } catch { /* use as-is */ }

  // Read manifest
  let manifest = null;
  let manifestError = null;
  try {
    const raw = await readFile(join(meshRootCanonical, 'mesh.json'), 'utf8');
    manifest = JSON.parse(raw);
  } catch (err) {
    manifestError = err.message;
  }

  // Decide which manifest entries to snapshot
  const entriesToCheck = [];
  if (manifest && Array.isArray(manifest.agents)) {
    for (const entry of manifest.agents) {
      if (agentName && entry.name !== agentName) continue;
      entriesToCheck.push(entry);
    }
  }

  // Load per-agent snapshots
  const agents = [];
  for (const entry of entriesToCheck) {
    const agentRoot = join(meshRootCanonical, entry.root);
    const agentSnapshot = await loadAgentSnapshot(agentRoot, entry);
    agents.push(agentSnapshot);
  }

  // Pre-generate expected registries (needed by checkConformance, pure step)
  // We generate with a placeholder binPath so peer-name comparison is stable.
  let expectedRegistries = null;
  if (manifest && !manifestError) {
    try {
      expectedRegistries = generateRegistry(manifest, {
        meshRootAbs: meshRootCanonical,
        binPath: '<bin>'
      });
    } catch { /* ignore; wiring check will flag */ }
  }

  return {
    meshRoot: meshRootCanonical,
    manifest,
    manifestError,
    agents,
    expectedRegistries
  };
}

/**
 * Load a single agent's snapshot from disk.
 *
 * @param {string} agentRoot       absolute path to the agent folder
 * @param {object} manifestEntry   the agent's manifest entry
 * @returns {Promise<object>}
 */
async function loadAgentSnapshot(agentRoot, manifestEntry) {
  // agent.json
  let agentJson = null;
  let agentJsonError = null;
  try {
    agentJson = JSON.parse(await readFile(join(agentRoot, 'agent.json'), 'utf8'));
  } catch (err) {
    agentJsonError = err.code === 'ENOENT' ? null : err.message;
    // If ENOENT, agentJson stays null, agentJsonError stays null (just absent)
  }

  // prompts/system.md
  let systemMdExists = false;
  let systemMdContent = null;
  try {
    systemMdContent = await readFile(join(agentRoot, 'prompts', 'system.md'), 'utf8');
    systemMdExists = true;
  } catch { /* absent */ }

  // .mcp.json
  let mcpJson = null;
  let mcpJsonError = null;
  try {
    mcpJson = JSON.parse(await readFile(join(agentRoot, '.mcp.json'), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') mcpJsonError = err.message;
  }

  // Discover tools/*/server.mjs
  const toolServers = await discoverToolServers(agentRoot);

  // registry.json
  let registryJson = null;
  let registryMarker = null;
  try {
    const raw = await readFile(join(agentRoot, 'registry.json'), 'utf8');
    registryJson = JSON.parse(raw);
    registryMarker = registryJson['x-agentmesh-generated'] === true ? true : false;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // parse error or permission error — treat as absent
    }
  }

  // Canonical realpath (for root-containment)
  let agentRootCanonical = null;
  try {
    agentRootCanonical = await realpath(agentRoot);
  } catch { /* folder may not exist */ }

  // Canonical directory structure (spec 2026-06-10 §4) — existence per dir
  const structureDirs = [];
  for (const dir of CANONICAL_DIRS) {
    let exists = false;
    try { await access(join(agentRoot, dir)); exists = true; } catch { /* absent */ }
    structureDirs.push({ dir, exists });
  }

  // Other prompt files (for standalone-runnable heuristic)
  const generatedPrompts = [];
  for (const relPath of ['prompts/ask.md', 'prompts/do.md']) {
    try {
      const content = await readFile(join(agentRoot, relPath), 'utf8');
      generatedPrompts.push({ path: relPath, content });
    } catch { /* absent */ }
  }

  return {
    name: manifestEntry.name,
    root: manifestEntry.root,
    served: manifestEntry.served,
    enabledModes: manifestEntry.enabledModes || [],
    peers: manifestEntry.peers || [],
    agentRoot,
    agentRootCanonical,
    agentJson,
    agentJsonError,
    structureDirs,
    systemMdExists,
    systemMdContent,
    generatedPrompts,
    mcpJson,
    mcpJsonError,
    toolServers,
    registryJson,
    registryMarker
  };
}

async function discoverToolServers(agentRoot) {
  const toolsDir = join(agentRoot, 'tools');
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
// checkConformance — PURE (synchronous, no I/O)
// ---------------------------------------------------------------------------

/**
 * Check conformance given a snapshot produced by loadSnapshot().
 *
 * @param {object} snapshot  result of loadSnapshot()
 * @returns {{ ok: boolean, rules: Array<{ rule: string, level: 'pass'|'warn'|'fail', detail: string }> }}
 */
export function checkConformance(snapshot) {
  const rules = [];

  for (const agent of snapshot.agents) {
    checkAnatomy(agent, rules);
    checkStructure(agent, rules);
    checkTools(agent, rules);
    checkCard(agent, rules);
    checkEnabledModes(agent, rules);
    checkStandaloneRunnable(agent, rules);
    checkVersion(agent, rules);
  }

  // Mesh-level rules (only when manifest is present)
  if (snapshot.manifest && !snapshot.manifestError) {
    checkWiring(snapshot, rules);
    checkRootContainment(snapshot, rules);
  }

  const ok = rules.every(r => r.level !== 'fail');
  return { ok, rules };
}

// ---------------------------------------------------------------------------
// Per-rule checkers (all pure)
// ---------------------------------------------------------------------------

function checkAnatomy(agent, rules) {
  // agent.json
  if (agent.agentJsonError) {
    rules.push({
      rule: 'anatomy',
      level: 'fail',
      detail: `[${agent.name}] agent.json unreadable: ${agent.agentJsonError}`
    });
  } else if (!agent.agentJson) {
    rules.push({
      rule: 'anatomy',
      level: 'fail',
      detail: `[${agent.name}] agent.json is missing`
    });
  } else {
    rules.push({
      rule: 'anatomy',
      level: 'pass',
      detail: `[${agent.name}] agent.json present`
    });
  }

  // prompts/system.md
  if (!agent.systemMdExists) {
    rules.push({
      rule: 'anatomy',
      level: 'fail',
      detail: `[${agent.name}] prompts/system.md is missing`
    });
  } else {
    rules.push({
      rule: 'anatomy',
      level: 'pass',
      detail: `[${agent.name}] prompts/system.md present`
    });
  }
}

/**
 * Canonical directory structure (spec 2026-06-10 §4): every agent must carry
 * the canonical dirs even when empty. Drift = FAIL (doctor --apply seeds them).
 */
function checkStructure(agent, rules) {
  const missing = (agent.structureDirs || []).filter((d) => !d.exists).map((d) => d.dir);
  if (missing.length === 0) {
    rules.push({
      rule: 'structure',
      level: 'pass',
      detail: `[${agent.name}] canonical folder structure present`
    });
    return;
  }
  for (const dir of missing) {
    rules.push({
      rule: 'structure',
      level: 'fail',
      detail: `[${agent.name}] required directory "${dir}" is missing — run doctor --apply to seed it`
    });
  }
}

function checkTools(agent, rules) {
  // Build set of paths declared in .mcp.json (normalize leading './')
  const declaredPaths = new Set();
  if (agent.mcpJson && typeof agent.mcpJson === 'object') {
    const servers = agent.mcpJson.mcpServers || {};
    for (const cfg of Object.values(servers)) {
      if (Array.isArray(cfg.args) && cfg.args.length > 0) {
        declaredPaths.add(cfg.args[0].replace(/^\.\//, ''));
      }
    }
  }

  // Every tools/<x>/server.mjs must be declared in .mcp.json
  for (const server of agent.toolServers) {
    const normalized = server.replace(/^\.\//, '');
    if (!declaredPaths.has(normalized)) {
      rules.push({
        rule: 'tools',
        level: 'fail',
        detail: `[${agent.name}] ${server} exists but is not declared in .mcp.json`
      });
    } else {
      rules.push({
        rule: 'tools',
        level: 'pass',
        detail: `[${agent.name}] ${server} declared in .mcp.json`
      });
    }
  }

  // Every IN-FOLDER .mcp.json declaration must point at a present server.mjs
  // (no dangling). EXTERNAL stdio servers (absolute paths or anything outside
  // tools/) are legitimate — the mesh passes them verbatim — so they are not
  // checked here.
  if (agent.mcpJson && typeof agent.mcpJson === 'object') {
    const servers = agent.mcpJson.mcpServers || {};
    for (const [serverName, cfg] of Object.entries(servers)) {
      if (!Array.isArray(cfg.args) || cfg.args.length === 0) continue;
      const path = cfg.args[0].replace(/^\.\//, '');
      const inFolderTool = /^tools\//.test(path);
      if (!inFolderTool) continue; // external server — out of this rule's scope
      const found = agent.toolServers.some(s => s.replace(/^\.\//, '') === path);
      if (!found) {
        rules.push({
          rule: 'tools',
          level: 'fail',
          detail: `[${agent.name}] .mcp.json entry "${serverName}" (${path}) has no matching server.mjs`
        });
      }
    }
  }

  // If nothing to check, emit a generic pass
  if (
    agent.toolServers.length === 0 &&
    (!agent.mcpJson || Object.keys(agent.mcpJson.mcpServers || {}).length === 0)
  ) {
    rules.push({
      rule: 'tools',
      level: 'pass',
      detail: `[${agent.name}] no tool servers (pass)`
    });
  }
}

function checkCard(agent, rules) {
  if (!agent.agentJson) {
    rules.push({
      rule: 'card',
      level: 'fail',
      detail: `[${agent.name}] cannot check card: agent.json missing`
    });
    return;
  }

  try {
    const card = buildAgentCard({
      self: agent.agentJson,
      root: agent.agentRoot,
      url: `agent-mesh://${agent.name}`
    });
    if (!card || !card.name) {
      rules.push({
        rule: 'card',
        level: 'fail',
        detail: `[${agent.name}] buildAgentCard returned an incomplete card`
      });
    } else {
      rules.push({
        rule: 'card',
        level: 'pass',
        detail: `[${agent.name}] AgentCard builds successfully (name: ${card.name})`
      });
    }
  } catch (err) {
    rules.push({
      rule: 'card',
      level: 'fail',
      detail: `[${agent.name}] buildAgentCard threw: ${err.message}`
    });
  }
}

/**
 * Wiring: registry.json peers match generateRegistry output; peer live-edge check.
 * Uses snapshot.expectedRegistries (pre-computed during loadSnapshot).
 */
function checkWiring(snapshot, rules) {
  const { manifest, agents, expectedRegistries } = snapshot;

  // Build map of agent-name → manifest entry
  const agentMap = new Map();
  for (const a of manifest.agents) {
    agentMap.set(a.name, a);
  }

  for (const agent of agents) {
    // Live-edge peer check (peers in manifest entry)
    for (const peerName of agent.peers) {
      if (!agentMap.has(peerName)) {
        rules.push({
          rule: 'wiring',
          level: 'fail',
          detail: `[${agent.name}] peer "${peerName}" does not exist in the manifest (dangling peer)`
        });
      } else {
        const peer = agentMap.get(peerName);
        if (!peer.served) {
          rules.push({
            rule: 'wiring',
            level: 'fail',
            detail: `[${agent.name}] peer "${peerName}" has served:false — live edges must point to served agents`
          });
        } else {
          rules.push({
            rule: 'wiring',
            level: 'pass',
            detail: `[${agent.name}] peer "${peerName}" is a live served edge`
          });
        }
      }
    }

    // Registry.json drift check
    if (agent.registryJson !== null) {
      if (agent.registryMarker === true) {
        // Managed — compare peer names to expected
        if (expectedRegistries && expectedRegistries[agent.name]) {
          const expected = expectedRegistries[agent.name];
          const actualPeerNames = Object.keys(agent.registryJson.peers || {}).sort();
          const expectedPeerNames = Object.keys(expected.peers || {}).sort();
          if (JSON.stringify(actualPeerNames) !== JSON.stringify(expectedPeerNames)) {
            rules.push({
              rule: 'wiring',
              level: 'fail',
              detail: `[${agent.name}] registry.json peers [${actualPeerNames.join(',')}] differ from expected [${expectedPeerNames.join(',')}] — drifted from manifest`
            });
          } else {
            rules.push({
              rule: 'wiring',
              level: 'pass',
              detail: `[${agent.name}] registry.json matches manifest`
            });
          }
        } else {
          rules.push({
            rule: 'wiring',
            level: 'warn',
            detail: `[${agent.name}] could not generate expected registry for comparison`
          });
        }
      } else {
        // Authored (marker === false)
        rules.push({
          rule: 'wiring',
          level: 'warn',
          detail: `[${agent.name}] registry.json is Authored (no marker) — cannot verify wiring`
        });
      }
    } else if (agent.peers.length > 0) {
      rules.push({
        rule: 'wiring',
        level: 'fail',
        detail: `[${agent.name}] has peers declared but no registry.json exists`
      });
    } else {
      rules.push({
        rule: 'wiring',
        level: 'pass',
        detail: `[${agent.name}] no peers, no registry required`
      });
    }
  }
}

function checkRootContainment(snapshot, rules) {
  const { meshRoot, agents } = snapshot;

  for (const agent of agents) {
    if (!agent.agentRootCanonical) {
      rules.push({
        rule: 'root-containment',
        level: 'warn',
        detail: `[${agent.name}] agent folder does not exist — cannot check root containment`
      });
      continue;
    }

    const rel = relative(meshRoot, agent.agentRootCanonical);
    const escapes = rel === '..' ||
      rel.startsWith(`..${sep}`) ||
      rel.startsWith('../') ||
      isAbsolute(rel);

    if (escapes) {
      rules.push({
        rule: 'root-containment',
        level: 'fail',
        detail: `[${agent.name}] agent root "${agent.agentRootCanonical}" escapes mesh root "${meshRoot}"`
      });
    } else {
      rules.push({
        rule: 'root-containment',
        level: 'pass',
        detail: `[${agent.name}] agent root is inside mesh root`
      });
    }
  }
}

function checkStandaloneRunnable(agent, rules) {
  const xam = agent.agentJson?.['x-agentmesh'];
  const requiredPeers = xam?.requiredPeers;

  if (Array.isArray(requiredPeers) && requiredPeers.length > 0) {
    rules.push({
      rule: 'standalone-runnable',
      level: 'fail',
      detail: `[${agent.name}] declares x-agentmesh.requiredPeers [${requiredPeers.join(', ')}] — agent cannot run standalone (violates invariant)`
    });
    return;
  }

  // Heuristic: warn on unconditional peer/delegate directives in prompt files
  const UNCONDITIONAL_PEER_RE = /always .*(delegate|peer|call )/i;
  const allPrompts = [
    ...(agent.systemMdContent ? [{ path: 'prompts/system.md', content: agent.systemMdContent }] : []),
    ...agent.generatedPrompts
  ];

  for (const { path, content } of allPrompts) {
    const lines = content.split('\n');
    for (const line of lines) {
      if (UNCONDITIONAL_PEER_RE.test(line)) {
        rules.push({
          rule: 'standalone-runnable',
          level: 'warn',
          detail: `[${agent.name}] ${path} contains possible unconditional peer directive: "${line.trim()}"`
        });
        return;
      }
    }
  }

  rules.push({
    rule: 'standalone-runnable',
    level: 'pass',
    detail: `[${agent.name}] no requiredPeers and no unconditional peer directives detected`
  });
}

function checkEnabledModes(agent, rules) {
  const xam = agent.agentJson?.['x-agentmesh'];
  const declaredModes = Array.isArray(xam?.modes) ? xam.modes : null;
  const enabledModes = agent.enabledModes || [];

  // served:true ⇒ non-empty enabledModes
  if (agent.served && enabledModes.length === 0) {
    rules.push({
      rule: 'enabled-modes',
      level: 'fail',
      detail: `[${agent.name}] served:true but enabledModes is empty`
    });
    return;
  }

  // enabledModes ⊆ declared modes
  if (declaredModes === null) {
    if (enabledModes.length > 0) {
      rules.push({
        rule: 'enabled-modes',
        level: 'fail',
        detail: `[${agent.name}] enabledModes [${enabledModes.join(', ')}] set but x-agentmesh.modes not declared in agent.json`
      });
    } else {
      rules.push({
        rule: 'enabled-modes',
        level: 'pass',
        detail: `[${agent.name}] no modes declared or enabled`
      });
    }
    return;
  }

  const declaredSet = new Set(declaredModes);
  const unsupported = enabledModes.filter(m => !declaredSet.has(m));
  if (unsupported.length > 0) {
    rules.push({
      rule: 'enabled-modes',
      level: 'fail',
      detail: `[${agent.name}] enabledModes [${unsupported.join(', ')}] not in declared modes [${declaredModes.join(', ')}]`
    });
  } else {
    rules.push({
      rule: 'enabled-modes',
      level: 'pass',
      detail: `[${agent.name}] enabledModes [${enabledModes.join(', ')}] ⊆ declared [${declaredModes.join(', ')}]`
    });
  }
}

function checkVersion(agent, rules) {
  const xam = agent.agentJson?.['x-agentmesh'];
  const agentVersion = xam?.meshVersion;

  if (typeof agentVersion !== 'string' || !agentVersion) {
    rules.push({
      rule: 'version',
      level: 'warn',
      detail: `[${agent.name}] x-agentmesh.meshVersion not declared`
    });
    return;
  }

  if (agentVersion === CURRENT_MESH_VERSION) {
    rules.push({
      rule: 'version',
      level: 'pass',
      detail: `[${agent.name}] meshVersion ${agentVersion} is current`
    });
  } else {
    rules.push({
      rule: 'version',
      level: 'warn',
      detail: `[${agent.name}] meshVersion "${agentVersion}" behind current "${CURRENT_MESH_VERSION}" — migratable`
    });
  }
}
