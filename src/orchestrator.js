/**
 * src/orchestrator.js
 *
 * Route-then-execute for a `role:"orchestrator"` agent (shell). Instead of one
 * heavy agentic loop, it:
 *   1. discovers peers' sanitized cards (primaryTool/intents) via A2A initialize,
 *   2. routes the task — rule pass first (zero LLM), one structured LLM turn as
 *      fallback (routing.js),
 *   3. executes the chosen route over its OWN createA2AClient send:
 *        - tool  → message with agentmesh/toolCall → peer fast-path (no worker),
 *        - agent → normal delegation for tasks needing reasoning,
 *        - none  → falls back to a full worker on its own root.
 *
 * `agentmesh/toolCall` is framework-set here (never model-emitted), preserving the
 * worker peer-bridge's `{peer,mode,task}` anti-spoof surface. The orchestrator's
 * runId becomes the peer's `agentmesh/parent_run_id` (board edge correlation).
 */

import { createRunLog, appendRunLog } from './log.js';
import { readManagedRegistry } from './a2a/registry.js';
import { createA2AClient } from './a2a/stdio-client.js';
import { RESERVED_BRIDGE_ENV } from './a2a/peer-bridge.js';
import { routeByRules, buildRoutingPrompt, validateLlmDecision } from './routing.js';
import { extractFirstJson } from './json-extract.js';
import { enterCallContext } from './context.js';
import { spawnFile } from './process.js';
import { delegateTask } from './delegate.js';
import { DEFAULT_DEPTH, DEFAULT_TIMEOUT_MS, readPositiveInt } from './config.js';
import { refused } from './errors.js';

const ONWARD_MODE = 'ask';

export async function orchestrate({ root, env, input, parentRunId = null }) {
  const task = input?.task;
  if (typeof task !== 'string' || !task.trim()) {
    return refused('bad_input', 'orchestrator requires a task.');
  }

  const { logPath, runId } = await createRunLog(root, env);
  const startedAt = new Date().toISOString();
  await appendRunLog(logPath, {
    id: runId, parent_run_id: parentRunId, route: 'orchestrate',
    started_at: startedAt, root, mode: 'ask', task, state: 'started'
  });

  let peersDebug = null;
  const finalize = async (result, decision) => {
    result.run_id = runId;
    await appendRunLog(logPath, {
      id: runId, parent_run_id: parentRunId, route: 'orchestrate',
      started_at: startedAt, finished_at: new Date().toISOString(),
      root, mode: 'ask', task, state: 'done',
      status: result.status, summary: result.summary, decision: decision || null, peers: peersDebug, result
    });
    return result;
  };

  // Peers come only from the marker-validated managed registry.
  const managed = await readManagedRegistry(root);
  const peerNames = Object.keys(managed.registry.peers);
  if (peerNames.length === 0) {
    // Nothing to route to → handle it ourselves with a normal worker.
    const result = await delegateTask({ root, env, input, parentRunId, route: 'agent' });
    return finalize(result);
  }

  // Recursion-threaded, reserved env for every onward send.
  const entered = enterCallContext(root, env, DEFAULT_DEPTH);
  if (!entered.ok) return finalize(entered.result);
  // Base on the real process env (PATH etc.) + the agent's env, then layer the
  // threaded call context on top (entered.env carries AGENT_MESH_PATH/DEPTH).
  const sendEnv = {
    ...process.env,
    ...env,
    ...entered.env,
    AGENT_MESH_MODE: ONWARD_MODE,
    ...(env.AGENT_MESH_MESH_ROOT ? { AGENT_MESH_MESH_ROOT: env.AGENT_MESH_MESH_ROOT } : {}),
    ...(env.AGENT_MESH_MESH_CEILING ? { AGENT_MESH_MESH_CEILING: env.AGENT_MESH_MESH_CEILING } : {})
  };
  const client = await createA2AClient(managed.registry, {
    env: sendEnv,
    protectedEnv: RESERVED_BRIDGE_ENV,
    requestTimeoutMs: readPositiveInt(env.AGENT_MESH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS) + 60_000
  });

  try {
    // Discover peer cards (sanitized primaryTool/intents) via initialize.
    const peers = [];
    for (const name of peerNames) {
      try {
        // initialize → { protocolVersion, agentCard }; the card carries x-agentmesh.
        const result = await client.initialize(name);
        const card = result?.agentCard || result || {};
        const xa = card['x-agentmesh'] || {};
        peers.push({ name, modes: xa.modes || [], primaryTool: xa.primaryTool || null });
      } catch {
        peers.push({ name, modes: [], primaryTool: null });
      }
    }

    peersDebug = peers;
    // Route: rules first, one LLM turn as fallback.
    let decision = routeByRules(task, peers);
    if (decision.route === 'llm-needed') {
      decision = await routeViaLlm({ task, peers, env });
    }

    // Execute.
    if (decision.route === 'tool') {
      const result = await sendToPeer(client, decision.target, {
        text: task, mode: ONWARD_MODE, toolCall: decision.toolCall, parentRunId: runId
      });
      return finalize(result, decision);
    }
    if (decision.route === 'agent') {
      const result = await sendToPeer(client, decision.target, {
        text: decision.task, mode: ONWARD_MODE, parentRunId: runId
      });
      return finalize(result, decision);
    }
    // route: none → handle ourselves.
    const result = await delegateTask({ root, env, input, parentRunId, route: 'agent' });
    return finalize(result, { route: 'none' });
  } finally {
    await client.close().catch(() => {});
  }
}

// Send to a peer over A2A and map its Task back to a delegate-shaped result.
async function sendToPeer(client, peer, { text, mode, toolCall, parentRunId }) {
  const metadata = { 'agentmesh/mode': mode };
  if (parentRunId) metadata['agentmesh/parent_run_id'] = parentRunId;
  if (toolCall) metadata['agentmesh/toolCall'] = toolCall;
  let task;
  try {
    task = await client.send(peer, { messageId: `${parentRunId || 'orch'}-${peer}`, role: 'ROLE_USER', parts: [{ text }], metadata });
  } catch (err) {
    return { status: 'error', summary: '', files_changed: null, log_path: '', error: { code: 'spawn_failed', message: err.message } };
  }
  const state = task?.status?.state ?? 'unknown';
  const md = task?.metadata ?? {};
  // v1.0 parts are discriminated by member name: text part = { text }.
  const summary =
    (task?.artifacts ?? []).flatMap((a) => (Array.isArray(a.parts) ? a.parts : []))
      .filter((p) => p && typeof p.text === 'string').map((p) => p.text).join('\n\n')
    || (task?.status?.message?.parts ?? []).filter((p) => p && typeof p.text === 'string').map((p) => p.text).join('\n');
  return {
    status: state === 'TASK_STATE_COMPLETED' ? 'done' : (state === 'TASK_STATE_REJECTED' ? 'refused' : 'error'),
    summary,
    files_changed: md['agentmesh/files_changed'] ?? null,
    log_path: md['agentmesh/log_path'] ?? '',
    ...(md['agentmesh/error_code'] ? { error: { code: md['agentmesh/error_code'], message: summary } } : {})
  };
}

// One cheap structured turn. Parse the first JSON object from stdout and validate
// it against the peer cards (never trusting an undeclared tool/peer).
async function routeViaLlm({ task, peers, env }) {
  const prompt = buildRoutingPrompt(task, peers);
  let out;
  try {
    out = await spawnFile(env.AGENT_MESH_CLAUDE || 'claude', ['-p', prompt], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      timeoutMs: 120_000
    });
  } catch {
    return { route: 'none' };
  }
  const parsed = extractFirstJson(out.stdout || '');
  if (!parsed) return { route: 'none' };
  return validateLlmDecision(parsed, peers);
}

