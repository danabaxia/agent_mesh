/**
 * src/builder/doctor.js
 *
 * Doctor: run conformance and apply safe fixes (Inc 3a).
 *
 * Ownership rules (§5.1):
 *   Managed   — registry.json with x-agentmesh-generated:true → auto-fix (regenerate)
 *   Seeded    — agent.json, prompts/*, .mcp.json → propose (*.proposed), never overwrite
 *   Authored  — everything else → flag only
 *
 * API:
 *   doctor(meshRoot, { agentName?, apply=false })
 *     → { fixed:[], seeded:[], proposed:[], flagged:[] }
 *
 * With apply=false (default): dry-run, report what WOULD be done.
 * With apply=true: perform auto-fixes and write proposals.
 */

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { atomicWriteFile } from '../atomic-write.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSnapshot, checkConformance } from './conformance.js';
import { generateRegistry, readManifest, writeManifest } from './manifest.js';
import { scaffoldGaps, CANONICAL_DIRS } from './scaffold.js';
import { proposePatch } from './propose.js';
import { discoverAgentStructure } from '../agent-context.js';
import { generateBridgeServerEntry } from '../mesh-mcp.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve bin path relative to this file (src/builder/doctor.js → ../../bin/agent-mesh.js)
import { resolve } from 'node:path';
const BIN_PATH = resolve(__dirname, '../../bin/agent-mesh.js');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run conformance on a mesh (or single agent) and apply safe fixes.
 *
 * @param {string} meshRoot   absolute path to the mesh root directory
 * @param {object} [opts]
 *   @param {string}  [opts.agentName]    check/fix only this agent
 *   @param {boolean} [opts.apply]        false = dry-run (default); true = execute fixes
 *   @param {boolean} [opts.managedOnly]  true = skip Seeded steps (seedMissingAnatomy,
 *                                        proposeSeededFixes); only fixRegistry + syncBridgeMcp
 * @returns {Promise<{ fixed: string[], seeded: string[], proposed: string[], flagged: string[] }>}
 */
export async function doctor(meshRoot, { agentName, apply = false, managedOnly = false } = {}) {
  const snapshot = await loadSnapshot(meshRoot, { agentName });
  const report = checkConformance(snapshot);

  const fixed = [];
  const seeded = [];
  const proposed = [];
  const flagged = [];

  // Regenerate manifest from disk to get the most current state
  const manifest = snapshot.manifest;
  if (!manifest) {
    flagged.push(`mesh.json missing or unreadable: ${snapshot.manifestError}`);
    return { fixed, seeded, proposed, flagged };
  }

  // ── Process each agent ──────────────────────────────────────────────────────
  for (const agent of snapshot.agents) {
    // 1. Auto-fix Managed: regenerate drifted/missing registry.json
    //    Only for managed (marker'd) or absent (never-existed) registry files.
    await fixRegistry(agent, manifest, meshRoot, apply, fixed, flagged);

    if (!managedOnly) {
      // 2. Seed genuinely missing anatomy files
      await seedMissingAnatomy(agent, apply, seeded, flagged);

      // 3. Propose patches for Seeded files that exist but have issues
      await proposeSeededFixes(agent, apply, proposed, flagged);
    }

    // 4. Sync the peer-bridge MCP entry into the agent's .mcp.json so ANY
    //    claude session started in the agent folder can reach its peers —
    //    not just dashboard/worker launches (which assemble their own
    //    config). Safe: the framework's config assembly DROPS reserved
    //    agentmesh_* names from agent-local files before re-adding the
    //    bridge, so this entry never duplicates in managed sessions.
    await syncBridgeMcp(agent, snapshot.meshRoot, apply, fixed, flagged);

    // 5. Install the board-notify SessionStart hook into the agent's
    //    .claude/settings.json so an interactive `claude` session started in
    //    the folder surfaces its board tasks. Identified by the hook script
    //    path, so author-authored SessionStart hooks are preserved.
    await syncBoardNotifyHook(agent, apply, fixed, flagged);
  }

  return { fixed, seeded, proposed, flagged };
}

// ---------------------------------------------------------------------------
// Sync: peer-bridge entry in <agent>/.mcp.json (merge-preserving)
// ---------------------------------------------------------------------------

const BRIDGE_NAME = 'agentmesh_peerbridge';

async function syncBridgeMcp(agent, meshRoot, apply, fixed, flagged) {
  const mcpPath = join(agent.agentRoot, '.mcp.json');

  // Read the file as it is on disk (authored content must survive verbatim).
  let doc = null;
  try { doc = JSON.parse(await readFile(mcpPath, 'utf8')); }
  catch (err) {
    if (err.code !== 'ENOENT') {
      flagged.push(`[${agent.name}] .mcp.json unparseable — peer-bridge entry not synced`);
      return;
    }
  }

  const hasPeers = (agent.peers ?? []).length > 0;
  const current = doc?.mcpServers?.[BRIDGE_NAME];
  // Stamp the reserved mesh env so a plain `claude` session started directly in
  // the agent folder (which has only this .mcp.json — unlike dashboard/worker
  // launches, which assemble env via mesh-mcp) can resolve its own caller name
  // from the manifest. Without it the bridge refuses with caller_identity_unresolved.
  // Same values generateRegistry stamps per peer: CEILING = mesh root, ROOT = mesh/ dir.
  const bridgeEnv = {
    AGENT_MESH_MESH_ROOT: join(meshRoot, 'mesh'),
    AGENT_MESH_MESH_CEILING: meshRoot
  };
  const wanted = hasPeers ? generateBridgeServerEntry(agent.agentRoot, BIN_PATH, bridgeEnv) : undefined;

  const same = JSON.stringify(current) === JSON.stringify(wanted);
  if (same) return; // idempotent — nothing to do

  const action = wanted
    ? `[${agent.name}] .mcp.json — peer-bridge entry synced (peers: ${agent.peers.join(', ')})`
    : `[${agent.name}] .mcp.json — stale peer-bridge entry removed (no peers)`;

  if (!apply) { fixed.push(`[dry-run] ${action}`); return; }

  if (!wanted && !doc) return; // nothing on disk, nothing wanted
  const next = doc && typeof doc === 'object' ? doc : {};
  next.mcpServers = next.mcpServers && typeof next.mcpServers === 'object' ? next.mcpServers : {};
  if (wanted) next.mcpServers[BRIDGE_NAME] = wanted;
  else delete next.mcpServers[BRIDGE_NAME];
  // Atomic (temp+rename): a claude session launching mid-sync reads old-or-new,
  // never a torn .mcp.json. mode 0o644 preserves config readability (writeFile's
  // prior default), not atomicWriteFile's 0o600 secret-file default.
  await atomicWriteFile(mcpPath, JSON.stringify(next, null, 2) + '\n', { mode: 0o644 });
  fixed.push(action);
}

// ---------------------------------------------------------------------------
// Sync: board-notify SessionStart hook in <agent>/.claude/settings.json
// ---------------------------------------------------------------------------

const BOARD_HOOK_MARKER = 'hooks/board-notify.js';

function boardNotifyHookEntry() {
  const hookPath = fileURLToPath(new URL('../../hooks/board-notify.js', import.meta.url));
  return {
    matcher: '*',
    hooks: [{ type: 'command', command: process.execPath, args: [hookPath] }]
  };
}

// Is `entry` the mesh's own board-notify SessionStart entry? (Identified by the
// hook script path, so we never touch an author's unrelated SessionStart hooks.)
function isBoardHookEntry(entry) {
  return (entry?.hooks ?? []).some(
    (h) => h?.type === 'command' && Array.isArray(h.args) &&
           h.args.some((a) => String(a).replace(/\\/g, '/').endsWith(BOARD_HOOK_MARKER))
  );
}

export async function syncBoardNotifyHook(agent, apply, fixed, flagged) {
  const settingsPath = join(agent.agentRoot, '.claude', 'settings.json');

  let doc = null;
  try { doc = JSON.parse(await readFile(settingsPath, 'utf8')); }
  catch (err) {
    if (err.code !== 'ENOENT') {
      flagged.push(`[${agent.name}] .claude/settings.json unparseable — board-notify hook not synced`);
      return;
    }
  }

  const hasPeers = (agent.peers ?? []).length > 0;
  const existing = doc?.hooks?.SessionStart ?? [];
  const others = existing.filter((e) => !isBoardHookEntry(e));
  const mineNow = existing.some(isBoardHookEntry);

  const wantMine = hasPeers;
  if (wantMine === mineNow) return; // idempotent

  const action = wantMine
    ? `[${agent.name}] .claude/settings.json — board-notify SessionStart hook synced`
    : `[${agent.name}] .claude/settings.json — board-notify SessionStart hook removed (no peers)`;

  if (!apply) { fixed.push(`[dry-run] ${action}`); return; }

  const next = doc && typeof doc === 'object' ? doc : {};
  next.hooks = next.hooks && typeof next.hooks === 'object' ? next.hooks : {};
  const merged = wantMine ? [...others, boardNotifyHookEntry()] : others;
  if (merged.length) next.hooks.SessionStart = merged;
  else delete next.hooks.SessionStart;

  await mkdir(dirname(settingsPath), { recursive: true });
  await atomicWriteFile(settingsPath, JSON.stringify(next, null, 2) + '\n', { mode: 0o644 });
  fixed.push(action);
}

// ---------------------------------------------------------------------------
// Fix: regenerate managed registry.json
// ---------------------------------------------------------------------------

async function fixRegistry(agent, manifest, meshRoot, apply, fixed, flagged) {
  // If registry exists and is Authored (marker === false), skip — never touch Authored
  if (agent.registryMarker === false) {
    // Authored — flag it
    flagged.push(
      `[${agent.name}] registry.json is Authored (no x-agentmesh-generated marker) — not auto-fixed; ` +
      `remove it manually if you want managed wiring`
    );
    return;
  }

  // Check if registry needs regeneration
  // Condition: registry is absent OR it is managed and its peers differ from expected
  let needsRegen = false;
  const agentRoot = agent.agentRoot;
  const registryPath = join(agentRoot, 'registry.json');

  if (agent.registryJson === null) {
    // Absent — might need to seed (only if there are peers)
    if (agent.peers.length > 0) {
      needsRegen = true;
    }
  } else if (agent.registryMarker === true) {
    // Managed — check drift
    const expectedRegistries = generateRegistry(manifest, {
      meshRootAbs: meshRoot,
      binPath: BIN_PATH
    });
    const expected = expectedRegistries[agent.name];
    if (expected) {
      // Compare full peer content (names AND embedded paths) so that path drift
      // caused by mesh relocation also triggers regeneration, not just peer-set changes.
      const actualPeers = agent.registryJson.peers || {};
      const expectedPeers = expected.peers || {};
      const actualPeerNames = Object.keys(actualPeers).sort();
      const expectedPeerNames = Object.keys(expectedPeers).sort();
      if (
        JSON.stringify(actualPeerNames) !== JSON.stringify(expectedPeerNames) ||
        actualPeerNames.some(n => JSON.stringify(actualPeers[n]) !== JSON.stringify(expectedPeers[n]))
      ) {
        needsRegen = true;
      }
    }
  }

  if (!needsRegen) return;

  const description = `[${agent.name}] registry.json regenerated from manifest`;

  if (!apply) {
    fixed.push(`[dry-run] ${description}`);
    return;
  }

  // Apply: regenerate
  const registries = generateRegistry(manifest, {
    meshRootAbs: meshRoot,
    binPath: BIN_PATH
  });
  const registry = registries[agent.name];
  if (!registry) {
    flagged.push(`[${agent.name}] could not generate registry — agent not in manifest`);
    return;
  }

  await mkdir(agentRoot, { recursive: true });
  await atomicWriteFile(registryPath, JSON.stringify(registry, null, 2) + '\n', { mode: 0o644 });
  fixed.push(description);
}

// ---------------------------------------------------------------------------
// Seed: create missing anatomy files
// ---------------------------------------------------------------------------

async function seedMissingAnatomy(agent, apply, seeded, flagged) {
  const agentRoot = agent.agentRoot;

  // Discover the agent's structure for scaffoldGaps
  let structure;
  try {
    structure = await discoverAgentStructure(agentRoot);
  } catch {
    flagged.push(`[${agent.name}] cannot discover structure — folder may not exist`);
    return;
  }

  // Extend structure with builder-extra fields
  const agentJsonPath = join(agentRoot, 'agent.json');
  let agentJsonExists = false;
  try { await access(agentJsonPath); agentJsonExists = true; } catch { /* absent */ }

  const agentMdPath = join(agentRoot, 'AGENT.md');
  let agentMdExists = false;
  try { await access(agentMdPath); agentMdExists = true; } catch { /* absent */ }

  const mcpJsonPath = join(agentRoot, '.mcp.json');
  let mcpJsonExists = false;
  try { await access(mcpJsonPath); mcpJsonExists = true; } catch { /* absent */ }

  const toolServers = agent.toolServers;

  // Existing canonical dirs (spec 2026-06-10 §4) — non-clobber: only missing
  // ones get seeded as <dir>/.gitkeep gap entries by scaffoldGaps.
  const existingDirs = [];
  for (const dir of CANONICAL_DIRS) {
    try { await access(join(agentRoot, dir)); existingDirs.push(dir); } catch { /* absent */ }
  }

  const extendedStructure = {
    ...structure,
    agentJson: agentJsonExists ? agentJsonPath : null,
    agentMd: agentMdExists ? agentMdPath : null,
    mcpJson: mcpJsonExists ? mcpJsonPath : null,
    toolServers,
    existingDirs
  };

  // Determine identity from agent.json if it exists, else use name
  const modes = Array.isArray(agent.agentJson?.['x-agentmesh']?.modes)
    ? agent.agentJson['x-agentmesh'].modes
    : (agent.enabledModes.length > 0 ? agent.enabledModes : ['ask']);
  const identity = { name: agent.name, modes };

  const gaps = scaffoldGaps(extendedStructure, identity);

  for (const { path: relPath, content } of gaps) {
    const absPath = join(agentRoot, relPath);
    const description = `[${agent.name}] seeded ${relPath}`;

    if (!apply) {
      seeded.push(`[dry-run] ${description}`);
      continue;
    }

    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, content, 'utf8');
    seeded.push(description);
  }
}

// ---------------------------------------------------------------------------
// Propose: emit *.proposed patches for Seeded files that exist but have issues
// ---------------------------------------------------------------------------

async function proposeSeededFixes(agent, apply, proposed, flagged) {
  const agentRoot = agent.agentRoot;

  // Propose: restamp meshVersion in agent.json if behind
  await proposeAgentJsonFix(agent, agentRoot, apply, proposed, flagged);

  // Propose: declare undeclared tool servers in .mcp.json
  await proposeMcpJsonFix(agent, agentRoot, apply, proposed, flagged);
}

async function proposeAgentJsonFix(agent, agentRoot, apply, proposed, flagged) {
  if (!agent.agentJson) return; // absent — handled by seeding

  const xam = agent.agentJson['x-agentmesh'];
  const currentVersion = xam?.meshVersion;

  if (currentVersion === '0.1.0') return; // up to date

  // Version is behind or missing — propose a fix
  const proposedContent = JSON.stringify({
    ...agent.agentJson,
    'x-agentmesh': {
      ...(typeof xam === 'object' && xam !== null ? xam : {}),
      meshVersion: '0.1.0'
    }
  }, null, 2) + '\n';

  const agentJsonPath = join(agentRoot, 'agent.json');
  const description = `[${agent.name}] agent.json — proposed meshVersion restamp to 0.1.0`;

  if (!apply) {
    proposed.push(`[dry-run] ${description}`);
    return;
  }

  const dest = await proposePatch(agentJsonPath, proposedContent);
  proposed.push(`${description} → ${dest}`);
}

async function proposeMcpJsonFix(agent, agentRoot, apply, proposed, flagged) {
  if (agent.toolServers.length === 0) return; // nothing to declare

  // Find undeclared tool servers
  const declaredPaths = new Set();
  if (agent.mcpJson && typeof agent.mcpJson === 'object') {
    const servers = agent.mcpJson.mcpServers || {};
    for (const cfg of Object.values(servers)) {
      if (Array.isArray(cfg.args) && cfg.args.length > 0) {
        declaredPaths.add(cfg.args[0].replace(/^\.\//, ''));
      }
    }
  }

  const undeclared = agent.toolServers.filter(s => !declaredPaths.has(s.replace(/^\.\//, '')));
  if (undeclared.length === 0) return;

  // Build proposed .mcp.json with undeclared servers added (unmarked)
  const base = agent.mcpJson || { mcpServers: {} };
  const proposedMcp = {
    ...base,
    mcpServers: { ...(base.mcpServers || {}) }
  };

  for (const server of undeclared) {
    // Extract name from tools/<name>/server.mjs
    const parts = server.split('/');
    const serverName = parts.length >= 2 ? parts[parts.length - 2] : server.replace(/[^a-zA-Z0-9_-]/g, '_');
    proposedMcp.mcpServers[serverName] = {
      type: 'stdio',
      command: 'node',
      args: [server]
      // readOnly intentionally absent — not granted without explicit confirmation
    };
  }

  const mcpJsonPath = join(agentRoot, '.mcp.json');
  const proposedContent = JSON.stringify(proposedMcp, null, 2) + '\n';
  const description = `[${agent.name}] .mcp.json — proposed declaration of ${undeclared.join(', ')}`;

  if (!apply) {
    proposed.push(`[dry-run] ${description}`);
    return;
  }

  const dest = await proposePatch(mcpJsonPath, proposedContent);
  proposed.push(`${description} → ${dest}`);
}
