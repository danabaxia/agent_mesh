/**
 * src/dashboard/shell-launcher.js
 *
 * Orchestrates the native-CLI plan/launch split for the dashboard:
 *   buildPlan() — gates' callers run first; computes the launch plan (NO fs side
 *   effects: the temp dir path is generated, not created), caches it by planId.
 *   launch(planId) — creates that exact dir exclusively, writes the files, opens
 *   the terminal.
 *
 * Reserved-name preflight runs in buildPlan (before caching) so a session can
 * never be planned when an `agentmesh_*` server is declared in any readable MCP
 * source (which, under the native non-strict launch, could shadow the bridge).
 */

import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { readFile, mkdir, writeFile, chmod } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { enterCallContext } from '../context.js';
import { DEFAULT_DEPTH } from '../config.js';
import { assembleMcpServers, buildBridgeEnv, generateBridgeServerEntry } from '../mesh-mcp.js';
import { RESERVED_PREFIX } from '../a2a/peer-bridge.js';
import { resolveSkillPolicy, skillPermissions } from '../skills-policy.js';
import {
  buildLaunchPlan, detectOpener, writePlanFiles, openTerminal, newTempDir, BIN_PATH
} from './shell.js';

const PLAN_TTL_MS = 120_000;

export class ShellLaunchError extends Error {
  constructor(code, message) { super(message); this.name = 'ShellLaunchError'; this.code = code; }
}

export function createShellLauncher({ meshRoot, which, platform = process.platform } = {}) {
  const plans = new Map(); // planId → { plan, bridgeConfigPath, bridgeConfigBody, createdAt }

  const sweep = () => {
    const now = Date.now();
    for (const [id, p] of plans) if (now - p.createdAt > PLAN_TTL_MS) plans.delete(id);
  };

  // Refuse if any readable MCP source declares an agentmesh_* server (it could
  // shadow the framework bridge under the non-strict native launch).
  async function preflightReservedNames(agentRoot) {
    const files = new Set([
      join(meshRoot, 'mesh', 'mcp.json'),
      join(homedir(), '.claude.json')
    ]);
    // agent root up to (and including) mesh root → project .mcp.json at each level
    let cur = agentRoot;
    while (cur && cur.length >= meshRoot.length && cur.startsWith(meshRoot)) {
      files.add(join(cur, '.mcp.json'));
      if (cur === meshRoot) break;
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    for (const f of files) {
      let parsed;
      try { parsed = JSON.parse(await readFile(f, 'utf8')); } catch { continue; }
      const servers = parsed?.mcpServers;
      if (!servers || typeof servers !== 'object') continue;
      for (const [name, server] of Object.entries(servers)) {
        if (!name.startsWith(RESERVED_PREFIX)) continue;
        // doctor --apply persists the framework's OWN bridge entry into each
        // peered agent's .mcp.json (so plain `claude` sessions reach peers).
        // An entry byte-identical to what the framework would generate for
        // that folder is wiring, not spoofing — anything else (different
        // name, args, command, or location) is still refused.
        if (name === 'agentmesh_peerbridge' &&
            JSON.stringify(server) === JSON.stringify(generateBridgeServerEntry(dirname(f), BIN_PATH))) {
          continue;
        }
        return f;
      }
    }
    return null;
  }

  /**
   * @param {object} a  { agentRoot (canonical), entry (manifest agent), resumeId?, sessionId?, continueSession? }
   *   resumeId — when set, the generated `claude` invocation gets `--resume <id>`
   *   so the external terminal RESUMES an existing session rather than starting a
   *   fresh one (used by POST /session/:id/open-terminal).
   *   sessionId — when set, the generated `claude` invocation gets
   *   `--session-id <id>` so a first-time external terminal launch creates the
   *   canonical session id shared with dashboard chat.
   *   continueSession — when true, generated `claude` invocation gets
   *   `--continue` so Claude chooses the newest session for the cwd.
   * @returns {Promise<{ planId, command, supported }>}
   */
  async function buildPlan({ agentRoot, entry, resumeId, sessionId, continueSession }) {
    const collision = await preflightReservedNames(agentRoot);
    if (collision) {
      throw new ShellLaunchError('reserved_name', `a reserved agentmesh_* MCP server is declared in ${collision}`);
    }

    const meshDir = join(meshRoot, 'mesh');
    const agentEnv = {
      AGENT_MESH_MESH_ROOT: meshDir,
      AGENT_MESH_MESH_CEILING: meshRoot,
      AGENT_MESH_ENABLED_MODES: (entry.enabledModes || []).join(',')
    };
    // Seed the call context (top of chain) so onward delegation from the
    // interactive session is cycle/depth-safe; export the threaded env.
    const entered = enterCallContext(agentRoot, agentEnv, DEFAULT_DEPTH);
    const exportEnv = buildBridgeEnv(entered.ok ? entered.env : agentEnv, agentEnv, { mode: 'ask' });

    const tempDir = newTempDir();
    // Native launch uses --strict-mcp-config: the generated config is the
    // AUTHORITATIVE, mesh-only MCP surface (no cwd/user/project bleed → no stray
    // approval prompts), so it must carry the agent's own tools + mesh-global +
    // bridge. Mirrors how the worker is configured ("same claude setting logic").
    const servers = await assembleMcpServers({
      agentRoot, meshRoot: meshDir, mode: 'native', binPath: BIN_PATH, includeAgentLocal: true
    });
    const bridgeConfigPath = join(tempDir, 'peer-bridge.json');
    const bridgeConfigBody = JSON.stringify({ mcpServers: servers }, null, 2) + '\n';

    // Per-agent skill allowlist. The interactive terminal is NOT `-p`; shell.js
    // disables native setting sources so user/project hooks cannot kill startup,
    // and this optional file re-adds only mesh-owned skill restrictions when the
    // policy is restrictive (mode !== 'all'). For mode:'all' we add nothing.
    // (meshRoot here is the mesh ROOT — mesh.json lives here and mesh/skills/ is
    // a subdir.)
    const skillPolicy = await resolveSkillPolicy(agentRoot, meshRoot);
    const skillPerms = skillPermissions(skillPolicy); // null when mode:'all'
    let skillSettingsPath = null;
    let skillSettingsBody = null;
    if (skillPerms) {
      skillSettingsPath = join(tempDir, 'skill-settings.json');
      skillSettingsBody = JSON.stringify({ permissions: skillPerms }, null, 2) + '\n';
    }

    const opener = detectOpener(platform, { which });
    const plan = buildLaunchPlan({ agentRoot, env: exportEnv, bridgeConfigPath, tempDir, opener, resumeId, sessionId, continueSession, skillSettingsPath });

    const planId = randomUUID();
    plans.set(planId, { plan, bridgeConfigPath, bridgeConfigBody, skillSettingsPath, skillSettingsBody, createdAt: Date.now() });
    sweep();
    return { planId, command: plan.command, supported: !!plan.openerArgv };
  }

  async function launch(planId, io = {}) {
    sweep();
    const cached = plans.get(planId);
    if (!cached) throw new ShellLaunchError('plan_expired', 'launch plan not found or expired; request a new plan');
    plans.delete(planId);
    const { plan, bridgeConfigPath, bridgeConfigBody, skillSettingsPath, skillSettingsBody } = cached;
    if (!plan.openerArgv) return { ok: false, reason: 'unsupported_platform', command: plan.command };
    try {
      const wf = io.writeFile || writeFile;
      await writePlanFiles(plan, bridgeConfigPath, bridgeConfigBody, {
        mkdir: io.mkdir || mkdir, writeFile: wf, chmod: io.chmod || chmod
      });
      // The per-agent skill-restriction settings file (only present when the
      // policy is restrictive). Written into the same exclusive 0700 dir as the
      // bridge config + script, with the same 0600 mode.
      if (skillSettingsPath && skillSettingsBody) {
        await wf(skillSettingsPath, skillSettingsBody, { flag: 'wx', mode: 0o600 });
      }
      const { opened } = openTerminal(plan, { spawn: io.spawn || spawn });
      return { ok: true, command: plan.command, opened };
    } catch (err) {
      return { ok: false, reason: 'open_failed', message: err.message, command: plan.command };
    }
  }

  return { buildPlan, launch };
}
