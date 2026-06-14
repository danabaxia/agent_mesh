/**
 * src/fast-path.js
 *
 * Deterministic primary-tool fast-path (shell). When a `SendMessage` carries a
 * structured `agentmesh/toolCall` that matches the agent's DECLARED
 * `x-agentmesh.primaryTool`, run that tool directly — no `claude -p` worker — and
 * return a delegate-shaped result. Constrained to the agent's own `readOnly` MCP
 * tool, ask-only, and wrapped in the SAME run-log + change-detect envelope as a
 * normal delegate so an in-root write by a misbehaving "readOnly" tool is still
 * audited (spec §6).
 *
 * The model never produces `toolCall` — it is set only by the framework
 * orchestrator's internal A2A send. A `toolCall` that does not match a declared
 * primaryTool is refused with `mode_disabled` (never silently executed).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createRunLog, appendRunLog } from './log.js';
import { captureChangeState, computeFilesChanged } from './change-detect.js';
import { callMcpTool } from './mcp-client.js';
import { readPositiveInt, DEFAULT_TIMEOUT_MS } from './config.js';
import { refused, resultError } from './errors.js';

const READONLY_MARKER = 'x-agentmesh';

/**
 * @param {object} opts
 *   @param {string} opts.root
 *   @param {object} opts.env
 *   @param {{ tool: string, args?: object }} opts.toolCall
 *   @param {string} [opts.task]          human-readable task (for the log)
 *   @param {string|null} [opts.parentRunId]
 * @returns {Promise<object>} delegate-shaped result ({status, summary, files_changed, log_path, error?})
 */
export async function fastPathExecute({ root, env, toolCall, task = '', parentRunId = null }) {
  // --- validate the toolCall shape ---
  if (!toolCall || typeof toolCall !== 'object' || typeof toolCall.tool !== 'string' || !toolCall.tool) {
    return refused('bad_input', 'agentmesh/toolCall must be { tool, args }.');
  }
  const args = (toolCall.args && typeof toolCall.args === 'object' && !Array.isArray(toolCall.args)) ? toolCall.args : {};

  // --- read the agent's declared primaryTool ---
  let self;
  try {
    self = JSON.parse(await readFile(join(root, 'agent.json'), 'utf8'));
  } catch {
    return refused('mode_disabled', 'agent.json missing or invalid; no primaryTool to fast-path.');
  }
  const pt = self?.[READONLY_MARKER]?.primaryTool;
  if (!pt || typeof pt !== 'object') {
    return refused('mode_disabled', 'this agent declares no primaryTool; toolCall refused.');
  }
  if (toolCall.tool !== pt.tool) {
    return refused('mode_disabled', `toolCall "${toolCall.tool}" does not match the declared primaryTool "${pt.tool}".`);
  }

  // --- the primary tool's server must be one of this agent's OWN readOnly servers ---
  let mcp;
  try {
    mcp = JSON.parse(await readFile(join(root, '.mcp.json'), 'utf8'));
  } catch {
    return refused('mode_disabled', '.mcp.json missing; cannot resolve the primaryTool server.');
  }
  const server = mcp?.mcpServers?.[pt.server];
  if (!server || typeof server !== 'object') {
    return refused('mode_disabled', `primaryTool server "${pt.server}" is not declared in .mcp.json.`);
  }
  if (server[READONLY_MARKER]?.readOnly !== true) {
    return refused('mode_disabled', `primaryTool server "${pt.server}" is not marked readOnly; fast-path is ask-only.`);
  }

  // --- validate args against the declared argsSchema (shape only) ---
  const schemaError = validateArgs(args, pt.argsSchema);
  if (schemaError) return refused('bad_input', schemaError);

  // strip our marker before handing the server entry to the MCP client
  const { [READONLY_MARKER]: _m, ...cleanServer } = server;

  // --- run-log + change-detect envelope (audit even though we skip the worker) ---
  const { logPath, runId } = await createRunLog(root, env);
  const startedAt = new Date().toISOString();
  await appendRunLog(logPath, {
    id: runId, parent_run_id: parentRunId, route: 'tool',
    started_at: startedAt, root, mode: 'ask', task, tool: pt.tool, state: 'started'
  });

  const before = await captureChangeState(root);
  const timeoutMs = readPositiveInt(env.AGENT_MESH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);

  const call = await callMcpTool({ cwd: root, serverConfig: cleanServer, tool: pt.tool, args, env, timeoutMs });
  const changed = await computeFilesChanged(root, before);

  let result;
  if (call.ok) {
    result = {
      status: 'done',
      summary: call.text || 'Completed without output.',
      files_changed: changed.files_changed,
      log_path: logPath
    };
  } else {
    result = resultError('internal', call.error || 'tool call failed');
    result.files_changed = changed.files_changed;
    result.log_path = logPath;
  }
  if (changed.preexisting_dirty) result.preexisting_dirty = true;
  if (changed.best_effort) result.best_effort = true;
  result.run_id = runId;

  await appendRunLog(logPath, {
    id: runId, parent_run_id: parentRunId, route: 'tool',
    started_at: startedAt, finished_at: new Date().toISOString(),
    root, mode: 'ask', task, tool: pt.tool, args,
    state: 'done', status: result.status, summary: result.summary, result
  });
  return result;
}

// Shape-only validation against a declared argsSchema like { query: "string" }.
function validateArgs(args, schema) {
  if (!schema || typeof schema !== 'object') return null; // no schema → no constraint
  for (const [key, type] of Object.entries(schema)) {
    if (!(key in args)) return `missing required arg "${key}".`;
    const actual = typeof args[key];
    if (typeof type === 'string' && actual !== type) {
      return `arg "${key}" must be ${type}, got ${actual}.`;
    }
  }
  return null;
}
