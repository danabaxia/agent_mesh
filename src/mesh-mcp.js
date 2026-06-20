/**
 * src/mesh-mcp.js
 *
 * The single source of truth for how the mesh configures `claude`'s MCP servers
 * for an agent. Used by BOTH the brokered worker (`delegate.js`) and the native
 * CLI entry point (`shell.js`) so there is exactly one "claude setting logic".
 *
 * The assembled set composes, per PROJECT.md §1.6 (as amended):
 *   1. the agent's own `.mcp.json` servers,
 *   2. the mesh-global `mesh/mcp.json` servers (grantable under the same rule),
 *   3. the framework peer bridge (`agentmesh_peerbridge`) when the agent has
 *      marker-validated peers.
 *
 * `mode` gates the GRANT, not the source (declaration ≠ grant):
 *   - 'ask'    → only `"x-agentmesh": { "readOnly": true }` servers (marker stripped),
 *   - 'do'     → none of the agent/mesh servers (empty),
 *   - 'native' → all agent/mesh servers (full; the gated, opt-in native session).
 * Servers in the reserved `agentmesh_*` namespace are dropped from EVERY source
 * (it is the framework bridge's namespace) before the bridge is added.
 */

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { readManagedRegistry } from './a2a/registry.js';
import { BRIDGE_SERVER_NAME, RESERVED_PREFIX } from './a2a/peer-bridge.js';
import { RECALL_SERVER_NAME } from './recall-mcp.js';

/** The framework recall MCP server entry (read-only; root-confined via its arg). */
export function generateRecallServerEntry(agentRoot, binPath) {
  return { command: 'node', args: [binPath, 'serve-recall', agentRoot] };
}

const READONLY_MARKER = 'x-agentmesh';

/**
 * The reserved-bridge env for peers a worker/native session spawns onward.
 * Threaded so cycle/depth detection works (PATH/DEPTH come only from env).
 *
 * AGENT_MESH_MODE is passed through from the parent task's mode so the bridge
 * can distinguish ask→do (refused as readonly_parent) from do→do (allowed in
 * v2). Callers supply the explicit mode via the third argument.
 *
 * @param {object} callEnv  threaded call-context env (PATH/DEPTH)
 * @param {object} env      parent task's full env (framework config pass-through)
 * @param {object} [opts]
 *   @param {string} [opts.mode]  parent task mode; absent → bridge stays ask-only
 */
export function buildBridgeEnv(callEnv, env, { mode } = {}) {
  const parentMode = mode || env?.AGENT_MESH_MODE;
  const out = parentMode ? { AGENT_MESH_MODE: parentMode } : {};
  if (callEnv?.AGENT_MESH_PATH !== undefined) out.AGENT_MESH_PATH = callEnv.AGENT_MESH_PATH;
  if (callEnv?.AGENT_MESH_DEPTH !== undefined) out.AGENT_MESH_DEPTH = callEnv.AGENT_MESH_DEPTH;
  for (const k of [
    'AGENT_MESH_MESH_ROOT',
    'AGENT_MESH_MESH_CEILING',
    'AGENT_MESH_CLAUDE',
    'AGENT_MESH_TIMEOUT_MS',
    'AGENT_MESH_LOG_DIR'
  ]) {
    if (env?.[k] !== undefined) out[k] = env[k];
  }
  // Forward the Claude OAuth credential to the bridge as a `${VAR}` placeholder (NOT the
  // literal — this entry is persisted to disk by doctor; the secret must never be written
  // there). claude expands it from the parent worker's env when it spawns the bridge, and
  // it cascades to the nested peer's serve-a2a → worker. Without this, nested delegation
  // works only under keychain auth (local) and fails under env-token auth (CI / headless /
  // server) with "Not logged in" — the root cause of the nightly L1 e2e failure (#150).
  // When the var is unset (keychain dev) claude omits it, so keychain auth is unaffected.
  out.CLAUDE_CODE_OAUTH_TOKEN = '${CLAUDE_CODE_OAUTH_TOKEN}';
  return out;
}

/** The framework peer-bridge MCP server entry (one source of truth). */
export function generateBridgeServerEntry(agentRoot, binPath, bridgeEnv) {
  const entry = { command: 'node', args: [binPath, 'serve-peer-bridge', agentRoot] };
  if (bridgeEnv && Object.keys(bridgeEnv).length) entry.env = bridgeEnv;
  return entry;
}

/**
 * Read one `{ mcpServers: {...} }` file → servers eligible under `mode`, with the
 * `x-agentmesh` marker stripped and any reserved `agentmesh_*` name dropped.
 */
async function readEligibleServers(file, mode) {
  if (mode === 'do') return {};                       // do: empty non-framework surface
  let parsed;
  try { parsed = JSON.parse(await readFile(file, 'utf8')); } catch { return {}; }
  const servers = parsed?.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return {};

  const out = {};
  for (const [name, server] of Object.entries(servers)) {
    if (!server || typeof server !== 'object') continue;
    if (name.startsWith(RESERVED_PREFIX)) continue;   // reserved framework namespace
    // ask grants only readOnly-marked; native grants all.
    if (mode === 'ask' && server[READONLY_MARKER]?.readOnly !== true) continue;
    const { [READONLY_MARKER]: _marker, ...clean } = server;
    out[name] = clean;
  }
  return out;
}

/**
 * Assemble the MCP server map the mesh hands to claude for `agentRoot`.
 *
 * @param {object} opts
 *   @param {string}  opts.agentRoot
 *   @param {string|null} opts.meshRoot   the `mesh/` dir (holds mcp.json); null if standalone
 *   @param {'ask'|'do'|'native'} opts.mode
 *   @param {string}  opts.binPath        bin/agent-mesh.js (for the bridge spawn)
 *   @param {object}  [opts.bridgeEnv]    env attached to the bridge entry
 * @returns {Promise<object>} `{ [serverName]: serverEntry }`
 */
export async function assembleMcpServers({ agentRoot, meshRoot, mode, binPath, bridgeEnv, includeAgentLocal = true }) {
  const servers = {};
  // mesh-global first, then agent-local (agent wins on a name collision).
  if (meshRoot) Object.assign(servers, await readEligibleServers(join(meshRoot, 'mcp.json'), mode));
  // The native launch is NON-strict, so native `claude` already auto-loads the
  // agent's own .mcp.json from cwd — re-injecting it would duplicate the server
  // names (Claude Code flags a conflict). So the native path sets
  // includeAgentLocal:false and relies on cwd. The worker is --strict (no cwd
  // auto-load), so it keeps the agent-local servers in the generated config.
  if (includeAgentLocal) Object.assign(servers, await readEligibleServers(join(agentRoot, '.mcp.json'), mode));

  // Framework peer bridge LAST, only when the marker-validated registry has peers.
  const managed = await readManagedRegistry(agentRoot);
  if (Object.keys(managed.registry.peers).length > 0) {
    servers[BRIDGE_SERVER_NAME] = generateBridgeServerEntry(agentRoot, binPath, bridgeEnv);
  }
  // Framework recall server — read-only, granted in BOTH modes (added after the
  // mode gate, like the bridge — the F1 fix), only when the agent has quick-memory
  // (the same marker that triggers the prompt's core-memory cutover, §5/§6).
  try {
    await stat(join(agentRoot, 'memory', 'quick.json'));
    servers[RECALL_SERVER_NAME] = generateRecallServerEntry(agentRoot, binPath);
  } catch { /* no quick.json → no recall server */ }
  return servers;
}
