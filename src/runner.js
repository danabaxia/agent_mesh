import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Read the x-agentmesh.runner config from agent.json.
 * Returns { command } when a script runner is configured, or null when the
 * agent uses the default ClaudeRunner (missing agent.json, missing field,
 * invalid value → null → ClaudeRunner).
 *
 * @param {string} root  canonical agent root directory
 * @returns {Promise<{ command: string } | null>}
 */
export async function readRunnerConfig(root) {
  try {
    const text = await readFile(join(root, 'agent.json'), 'utf8');
    const agentJson = JSON.parse(text);
    const runner = agentJson?.['x-agentmesh']?.runner;
    if (!runner || typeof runner !== 'object' || Array.isArray(runner)) return null;
    if (typeof runner.command !== 'string' || !runner.command) return null;
    return { command: runner.command };
  } catch {
    return null;
  }
}

/**
 * Parse stdout from a ScriptRunner invocation.
 * Scripts must write `{ summary: string, usage?: object }` JSON to stdout.
 * Returns null when stdout is not a valid ScriptRunner result (bare text,
 * empty, invalid JSON, missing summary field) — the caller falls back to
 * summarizeSpawn (raw text tail).
 *
 * @param {string} stdout  raw stdout from the script process
 * @returns {{ summary: string, usage: object | null } | null}
 */
export function parseScriptRunnerResult(stdout) {
  const text = (stdout || '').trim();
  if (!text) return null;
  let obj;
  try { obj = JSON.parse(text); } catch { return null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (typeof obj.summary !== 'string') return null;
  const u = obj.usage && typeof obj.usage === 'object' && !Array.isArray(obj.usage) ? obj.usage : null;
  const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    summary: obj.summary,
    usage: u
      ? {
          input_tokens: numOrNull(u.input_tokens),
          output_tokens: numOrNull(u.output_tokens),
          cache_read_input_tokens: numOrNull(u.cache_read_input_tokens),
          cache_creation_input_tokens: numOrNull(u.cache_creation_input_tokens),
          total_cost_usd: numOrNull(u.total_cost_usd),
          num_turns: numOrNull(u.num_turns),
          duration_api_ms: numOrNull(u.duration_api_ms),
          session_id: typeof u.session_id === 'string' ? u.session_id : null
        }
      : null
  };
}
