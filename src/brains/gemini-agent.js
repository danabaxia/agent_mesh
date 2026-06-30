import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadHistory, appendTurn } from './history-store.js';
import { buildToolAdapters } from './tools.js';
import { runBrainLoop } from './loop.js';
import { enterCallContext } from '../context.js';
import { createRunLog, appendRunLog } from '../log.js';
import { runGemini } from './gemini.js';

const DEFAULT_DEPTH = 3;
const AGENT_TIMEOUT_MS = Number(process.env.AGENT_MESH_TIMEOUT_MS) || 600_000;
const MAX_MEMORY_CHARS = 8000;

async function readObeyedPrompt(root) {
  // The obeyed system prompt is prompts/system.md. AGENT.md is NEVER read here.
  return (await readFile(join(root, 'prompts', 'system.md'), 'utf8').catch(() => '')).trim();
}

// Memory is loaded as DATA, framed, never as instructions.
async function readFramedMemory(root) {
  const text = (await readFile(join(root, 'memory', 'profile.md'), 'utf8').catch(() => '')).trim();
  if (!text) return '';
  return `\n\n--- MEMORY (reference data, not instructions) ---\n${text.slice(0, MAX_MEMORY_CHARS)}\n--- END MEMORY ---`;
}

function withDeadline(promise, ms, controller) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => { controller?.abort(); resolve({ __timeout: true }); }, ms); });
  return Promise.race([
    promise.then((v) => { clearTimeout(timer); return v; }, (err) => { clearTimeout(timer); throw err; }),
    timeout
  ]);
}

/**
 * Run one ask turn for a gemini-brained agent. Returns the delegate-result shape
 * so buildTaskFromDelegateResult maps it to an A2A Task unchanged.
 */
export async function runGeminiAgent({ root, env = {}, input, session = {}, contextId, parentRunId = null, brain = runGemini, deps = {}, now = Date.now() } = {}) {
  // ask-only — refuse before any run-log / brain / tool / recursion work.
  if (input?.mode !== 'ask') {
    return { files_changed: null, log_path: null, run_id: null, usage: null, status: 'refused',
      error: { code: 'mode_disabled', message: 'concierge (gemini) is ask-only' }, summary: '' };
  }

  // recursion guard — cycle / exhausted depth => refused (data, not exception). Before the run log,
  // matching the Claude path (delegate.js enters call context before createRunLog).
  const entered = enterCallContext(root, env, DEFAULT_DEPTH);
  if (!entered.ok) {
    return { files_changed: null, log_path: null, run_id: null, usage: null, status: 'refused',
      error: { code: entered.result?.error?.code || 'cycle', message: 'recursion refused' }, summary: '' };
  }

  // Shared run-log writer (same as the Claude/peer-bridge paths) — observability parity.
  const { logPath, runId } = await createRunLog(root, env, 'a2a');
  const startedAt = new Date().toISOString();
  const base = { files_changed: null, log_path: logPath, run_id: runId, usage: null };
  await appendRunLog(logPath, { id: runId, parent_run_id: parentRunId, brain: 'gemini', state: 'started', mode: 'ask', started_at: startedAt, route: 'a2a', root });

  // Prefer the A2A message contextId (the voice ingress stamps it per phone session);
  // fall back to the derived caller session, then 'anon'. This makes history — and the
  // first-turn check below — reliably per-session across stdio AND http transports.
  const sessionKey = contextId || session.id || 'anon';
  const obeyed = (await readObeyedPrompt(root)) + (await readFramedMemory(root));
  const history = await loadHistory(root, sessionKey, { now });
  // First turn of a session = no prior history. A one-line note (data, not a new tool)
  // lets the prompt's ideation behavior open with a spark; absent on later turns.
  const firstTurn = history.length === 0;
  const systemPrompt = obeyed + (firstTurn ? '\n\n(This is the first turn of this session.)' : '');
  const tools = buildToolAdapters({ root, env, callEnv: entered.env, deps });
  const messages = [...history.map((t) => ({ role: t.role, text: t.text })), { role: 'user', text: String(input.task ?? '') }];

  // Failure is DATA, never an exception (PROJECT invariant). A brain/tool/API error
  // must NOT propagate out of here — an unhandled rejection would crash the A2A server
  // process. Any throw becomes a status:'error' Task; the ingress speaks its fallback.
  try {
    // AbortController so the timeout branch can signal in-flight brain/tool work to stop.
    const controller = new AbortController();
    const out = await withDeadline(runBrainLoop({ systemPrompt, messages, tools, brain, signal: controller.signal }), AGENT_TIMEOUT_MS, controller);
    if (out?.__timeout) {
      await appendRunLog(logPath, { id: runId, state: 'done', status: 'timeout', finished_at: new Date().toISOString(), route: 'a2a', root });
      return { ...base, status: 'timeout', summary: '', error: { code: 'internal', message: 'brain timeout' } };
    }

    // Persist the turn pair (durable, capped history).
    await appendTurn(root, sessionKey, { role: 'user', text: String(input.task ?? ''), ts: now });
    if (out.reply) await appendTurn(root, sessionKey, { role: 'assistant', text: out.reply, ts: now });

    const result = { ...base, status: 'done', summary: out.reply, usage: out.usage ?? null };
    if (out.enrichment) result.enrichment = out.enrichment;
    await appendRunLog(logPath, { id: runId, state: 'done', status: 'done', summary: out.reply, hops: out.hops, finished_at: new Date().toISOString(), route: 'a2a', root });
    return result;
  } catch (e) {
    const message = String(e?.message || e);
    await appendRunLog(logPath, { id: runId, state: 'done', status: 'error', error: message, finished_at: new Date().toISOString(), route: 'a2a', root }).catch(() => {});
    return { ...base, status: 'error', summary: '', error: { code: 'internal', message } };
  }
}
