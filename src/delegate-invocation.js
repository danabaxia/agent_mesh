import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DEFAULT_LOG_DIR, READ_TOOLS, WRITE_TOOLS } from './config.js';
import { readManifest } from './builder/manifest.js';
import { buildAgentRuntimePrompt } from './agent-context.js';
import { readQuickMemory } from './quick-memory.js';
import { selectPrefetch, renderPrefetchBlock } from './prefetch.js';
import { assembleMcpServers, buildBridgeEnv } from './mesh-mcp.js';
import { mergeSettings, readLayer, resolveAuthorLayerPaths } from './settings-merge.js';
import { resolveSkillPolicy, skillToolEnabled, skillPermissions } from './skills-policy.js';

export const BIN_PATH = fileURLToPath(new URL('../bin/agent-mesh.js', import.meta.url));

// Replace the large --append-system-prompt value with a short marker so a
// grouped-log line stays small (atomic append) and readable.
export function compactArgv(argv) {
  if (!Array.isArray(argv)) return argv;
  const out = argv.slice();
  const i = out.indexOf('--append-system-prompt');
  if (i !== -1 && typeof out[i + 1] === 'string') {
    out[i + 1] = `[system-prompt ${out[i + 1].length} chars omitted]`;
  }
  return out;
}

export async function buildClaudeInvocation({ root, mode, task, env, callEnv, claudeEnv, session = null }) {
  // Spec §4: prompt is now assembled by agent-context.buildAgentRuntimePrompt
  // (system → memory → workflows → mode prompt → global/local skill summaries).
  // meshRoot is resolved per chunk-2 rule: env override → walk-up to nearest
  // ancestor containing a `mesh/` directory → null (no global layer). It points
  // at the `mesh/` dir itself; the mesh ROOT (where mesh.json lives) is parent.
  const meshRoot = await resolveMeshRoot(root, env);
  const skillPolicy = await resolveSkillPolicy(root, meshRoot ? dirname(meshRoot) : null);
  const args = buildClaudeInvocationSync(mode, task, skillToolEnabled(skillPolicy));
  // Multi-turn peer sessions (§5.5): when C derives a session, resume the existing
  // transcript (--resume) or start a new one (--session-id), mirroring the dashboard
  // session-runner's choice. session=null (every non-multi-turn caller) → unchanged.
  if (session && session.id) {
    args.push(session.resume ? '--resume' : '--session-id', session.id);
  }
  const identity = await buildAgentRuntimePrompt(root, mode, { meshRoot, env });
  // Headless prefetch (spec §6): the worker's task is known at spawn time and the
  // first-turn MCP race makes a turn-1 `recall` unreliable, so match the task
  // against quick-memory NOW and append the top-K bodies directly into the prompt,
  // DATA-fenced. ADDITIVE — the `recall` verbs stay exposed for what prefetch
  // missed (no weak lexical match strands the worker). A weak/empty match (e.g. a
  // digest run, or an agent with no quick.json) appends nothing → unchanged.
  const prefetch = renderPrefetchBlock(selectPrefetch(await readQuickMemory(root), task));
  const promptParts = [identity, prefetch].filter(Boolean);
  if (promptParts.length) args.push('--append-system-prompt', promptParts.join('\n\n'));

  // Unified mesh claude config (src/mesh-mcp.js) — the SAME assembler the native
  // CLI entry point uses: agent .mcp.json + mesh-global mesh/mcp.json (gated by
  // mode) + the framework peer bridge when marker-validated peers exist (added
  // last; agentmesh_* dropped from author sources first).
  const servers = await assembleMcpServers({
    agentRoot: root,
    meshRoot,
    mode,
    binPath: BIN_PATH,
    bridgeEnv: buildBridgeEnv(callEnv, env, { mode })
  });

  args.push('--strict-mcp-config', '--mcp-config', await writeMcpConfig(servers));
  // Headless `claude -p` gates MCP tool calls behind the permission allowlist.
  // Allowlist each server's tools so the worker can actually call them. Empty set
  // -> no allowlist -> default-deny preserved (e.g. `do` mode with no peers).
  const mcpAllow = Object.keys(servers).map((name) => `mcp__${name}`);
  if (mcpAllow.length) args.push('--allowedTools', mcpAllow.join(','));
  // Always pass --settings (mesh-built) AND --setting-sources "" (disable
  // native loading of user/project/local settings), so only the mesh's
  // allowlisted merge takes effect — author hooks declared outside the
  // merge never fire. Both modes.
  args.push('--settings', await createClaudeSettings(root, env, mode, claudeEnv, skillPermissions(skillPolicy)));
  args.push('--setting-sources', '');
  // Capture the worker's own token/cost accounting: `--output-format json` makes
  // `claude -p` emit a single terminal result envelope ({ result, usage,
  // total_cost_usd, num_turns, duration_api_ms, … }) on stdout instead of bare
  // text. delegate.js parses it (parseResultEnvelope) for both the summary
  // (`.result`) and a `usage` block, falling back to the raw text tail when the
  // output isn't a parseable envelope (timeout/error/older CLI). Appended LAST so
  // the early argv prefix other call sites assert on is unchanged. Pure
  // observability — no model-facing surface change.
  args.push('--output-format', 'json');
  if (mode === 'do') {
    // Headless `claude -p` still gates Edit/Write behind a permission
    // decision even when the tool is in --tools; with no interactive
    // approver the write never lands. acceptEdits auto-approves the edit.
    // The PreToolUse path-guard hook runs regardless of permission mode,
    // so cross-folder write confinement is unchanged — the boundary is
    // the hook, not the prompt. (do mode could not write at all before
    // this; caught by the real-claude E2E, not the fake-claude unit test.)
    args.push('--permission-mode', 'acceptEdits');
  }
  return { args };
}

// Resolve the global mesh layer root per spec §3 line 65-71. Lookup order:
//   1. `AGENT_MESH_MESH_ROOT` env var — explicit override (full path to the
//      mesh/ directory itself, not its parent).
//   2. walk up from `root` looking for an ancestor that contains a `mesh/`
//      subdirectory; return that `mesh/` path (the directory itself).
//   3. null — no global layer available; agent-context.js will skip global
//      skills cleanly (§9 line 296 "missing directories are ignored").
export async function resolveMeshRoot(root, env) {
  const override = env?.AGENT_MESH_MESH_ROOT;
  if (override) {
    try {
      const s = await stat(override);
      if (s.isDirectory()) return override;
    } catch {
      // override points nowhere → fall through to walk-up
    }
  }
  // Optional ceiling: the walk-up never goes ABOVE this ancestor (inclusive).
  // The mesh/ it finds is injected into the OBEYED worker prompt, so this bounds
  // whose content can reach the prompt. Set AGENT_MESH_MESH_CEILING to an
  // absolute, canonical ancestor path on shared/multi-tenant filesystems. Unset
  // → walk to the filesystem root (single-user default, threat-model in
  // PROJECT.md §1.5).
  const ceiling = env?.AGENT_MESH_MESH_CEILING || null;
  let current = root;
  while (true) {
    const candidate = join(current, 'mesh');
    try {
      const s = await stat(candidate);
      if (s.isDirectory()) return candidate;
    } catch {
      // no mesh/ here; keep walking
    }
    if (ceiling && current === ceiling) return null;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// Decide whether an ask-mode run may receive WEB_TOOLS. Operator-owned:
// the grant is read ONLY from the mesh.json manifest (never a self-declared
// agent.json card), so a tampered third-folder card cannot expand egress.
// ALL must hold: manifestRoot present; route !== 'digest'; the manifest lists
// a served:true, ask-enabled agent whose realpath-canonical root === `root`,
// with webTools === true.
export async function agentWantsWebTools({ root, manifestRoot, route }) {
  if (!manifestRoot || route === 'digest') return false;
  let manifest;
  try {
    manifest = await readManifest(manifestRoot);
  } catch {
    return false;
  }
  const agents = Array.isArray(manifest?.agents) ? manifest.agents : [];
  let canonRoot;
  try {
    canonRoot = await realpath(root);
  } catch {
    return false;
  }
  for (const a of agents) {
    if (a?.served !== true) continue;
    if (!Array.isArray(a.enabledModes) || !a.enabledModes.includes('ask')) continue;
    if (a.webTools !== true) continue;
    if (typeof a.root !== 'string') continue;
    let agentCanon;
    try {
      agentCanon = await realpath(join(manifestRoot, a.root));
    } catch {
      continue;
    }
    if (agentCanon === canonRoot) return true;
  }
  return false;
}

function buildClaudeInvocationSync(mode, task, includeSkill = false) {
  const tools = mode === 'ask' ? [...READ_TOOLS] : [...READ_TOOLS, ...WRITE_TOOLS];
  // `Skill` must be in --tools for headless `claude -p` to run ANY skill; the
  // per-skill restriction is enforced separately via the settings permissions
  // block (skillPermissions). Omitting Skill = "no skills at all" (mode:none).
  if (includeSkill) tools.push('Skill');
  return ['-p', task, '--tools', tools.join(',')];
}

export function buildClaudeEnv({ root, env, mode, callEnv, runId }) {
  const result = {
    ...process.env,
    // Workers must NOT self-update: any of the many spawned claude processes
    // triggering the npm auto-updater swaps the binary under concurrent
    // spawns → ENOENT races (observed 2026-06-10 and 2026-06-12T02:42Z).
    // Updates belong to the user's interactive claude; explicit env wins.
    DISABLE_AUTOUPDATER: '1',
    ...env,
    ...callEnv,
    AGENT_MESH_ROOT: root,
    AGENT_MESH_MODE: mode,
    // The worker's run id, inherited by the peer bridge it may spawn so onward
    // A2A sends can stamp `agentmesh/parent_run_id` for board correlation.
    AGENT_MESH_RUN_ID: runId
  };
  // The path-guard hook reads AGENT_MESH_HOOK_LOG from process.env to know
  // where to write denial audit records. The settings env block alone is not
  // sufficient because the claude CLI may not propagate settings-env keys that
  // start with AGENT_MESH_ to hook subprocess environments. Setting it here
  // ensures the hook inherits it via the standard parent→child env inheritance.
  if (mode === 'do') {
    const logDir = env?.AGENT_MESH_LOG_DIR || DEFAULT_LOG_DIR;
    result.AGENT_MESH_HOOK_LOG = join(resolve(root, logDir), 'path-guard-denials.jsonl');
  }
  return result;
}

export async function createClaudeSettings(root, env, mode, claudeEnv, skillPerms = null) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-mesh-'));
  const hookPath = fileURLToPath(new URL('../hooks/path-guard.js', import.meta.url));
  const hookLogDir = resolve(root, env.AGENT_MESH_LOG_DIR || DEFAULT_LOG_DIR);
  await mkdir(hookLogDir, { recursive: true });

  // Read the three author layers from the child's effective env.
  const paths = resolveAuthorLayerPaths(root, claudeEnv);
  const layerResults = await Promise.all(
    [paths.user, paths.project, paths.local].map((p) => (p ? readLayer(p) : { ok: false, reason: 'missing' }))
  );
  // Diagnostics — flow through stderr so they appear in the run log tail.
  for (const r of layerResults) {
    if (!r.ok && r.reason !== 'missing') {
      process.stderr.write(`[agent-mesh] settings-merge: ${r.reason} ${r.path || ''}: ${r.message || ''}\n`);
    }
  }
  const layers = layerResults.filter((r) => r.ok).map((r) => r.value);

  // Mode-specific overlay.
  const overlay = {
    disableAllHooks: false,
    hooks: mode === 'do'
      ? {
          PreToolUse: [
            {
              matcher: WRITE_TOOLS.join('|'),
              hooks: [
                // CLI exec form: command + args, no shell.
                { type: 'command', command: process.execPath, args: [hookPath] },
              ],
            },
          ],
        }
      : {},
    env: mode === 'do'
      ? { AGENT_MESH_ROOT: root, AGENT_MESH_HOOK_LOG: join(hookLogDir, 'path-guard-denials.jsonl') }
      : { AGENT_MESH_ROOT: root },
  };
  // Per-agent skill allowlist (PERMISSION surface). When non-null, flow it into
  // the overlay so mergeSettings unions deny/allow with any author-layer
  // permissions (overlay is appended last-word). null = no restriction (all
  // skills) — Skill is then in --tools with no permission gate.
  if (skillPerms) overlay.permissions = skillPerms;

  const merged = mergeSettings(layers, overlay);
  const path = join(dir, 'settings.json');
  await writeFile(path, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return path;
}

export async function writeMcpConfig(servers) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-mesh-mcp-'));
  const config = { mcpServers: servers };
  const path = join(dir, 'mcp.json');
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return path;
}

/**
 * Build the full ask-mode `claude` argv for an agent (NO -p prompt; the caller
 * appends the prompt). Mirrors delegate.js ask: identity prompt + READ_TOOLS +
 * strict mesh MCP + allowlist + mesh settings + setting-sources "".
 * @returns {Promise<{ args: string[] }>}  args = everything AFTER `claude`
 */
export async function buildAskInvocation({ root, env, callEnv, claudeEnv }) {
  const meshRoot = await resolveMeshRoot(root, env);
  const skillPolicy = await resolveSkillPolicy(root, meshRoot ? dirname(meshRoot) : null);
  const tools = [...READ_TOOLS];
  if (skillToolEnabled(skillPolicy)) tools.push('Skill');
  const args = ['--tools', tools.join(',')];
  const identity = await buildAgentRuntimePrompt(root, 'ask', { meshRoot, env });
  if (identity) args.push('--append-system-prompt', identity);
  const servers = await assembleMcpServers({
    agentRoot: root, meshRoot, mode: 'ask', binPath: BIN_PATH,
    bridgeEnv: buildBridgeEnv(callEnv, env, { mode: 'ask' })
  });
  args.push('--strict-mcp-config', '--mcp-config', await writeMcpConfig(servers));
  const mcpAllow = Object.keys(servers).map((name) => `mcp__${name}`);
  if (mcpAllow.length) args.push('--allowedTools', mcpAllow.join(','));
  args.push('--settings', await createClaudeSettings(root, env, 'ask', claudeEnv, skillPermissions(skillPolicy)));
  args.push('--setting-sources', '');
  return { args };
}
