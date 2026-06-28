import { readFile, readdir, access, realpath } from 'node:fs/promises';
import { join, dirname, normalize } from 'node:path';
import { MAX_LINE_CHARS, readPositiveInt, DEFAULT_CONTEXT_WINDOW } from '../config.js';
import { delegateTask } from '../delegate.js';
import { runAgent } from './run-agent.js';
import { fastPathExecute } from '../fast-path.js';
import { orchestrate } from '../orchestrator.js';
import { describeFolder } from '../description.js';
import { SerialQueue } from '../lock.js';
import { deriveSessionId, readEpoch, persistEpoch } from './session-id.js';
import { encodeProjectDir, transcriptExists, countTurns, readSessionHeadroom } from '../session-transcripts.js';
import { setLabel, recordEvent } from '../dashboard/session-index.js';
import { loadSnapshot, checkConformance } from '../builder/conformance.js';
import {
  A2A_PROTOCOL_VERSION,
  buildAgentCard,
  buildRejectedTask,
  buildTaskFromDelegateResult,
  rpcError,
  rpcResult,
  validateMessageSendParams
} from './protocol.js';

/**
 * Read the agent.json x-agentmesh.modes from the agent's folder.
 * Returns an array of strings when declared, or null when absent/unreadable.
 */
async function readAgentModes(root) {
  try {
    const raw = await readFile(join(root, 'agent.json'), 'utf8');
    const agentJson = JSON.parse(raw);
    const modes = agentJson?.['x-agentmesh']?.modes;
    if (Array.isArray(modes) && modes.length > 0) return modes;
    return null;
  } catch {
    return null;
  }
}

export async function createA2AStdioServer({ root, env, strict = false }) {
  const self = await describeFolder(root);
  const doQueue = new SerialQueue();

  // Read agent.json modes once at startup (capability gate)
  const agentModes = await readAgentModes(root);
  // describeFolder() (self) carries name/description/capabilities from AGENT.md;
  // role/primaryTool live in agent.json's x-agentmesh, so read that and merge it
  // in so the card advertises them (orchestrator discovery + fast-path).
  let agentXa = null;
  try {
    agentXa = JSON.parse(await readFile(join(root, 'agent.json'), 'utf8'))?.['x-agentmesh'] ?? null;
  } catch { /* no agent.json */ }
  const cardSelf = agentXa ? { ...self, 'x-agentmesh': agentXa } : self;
  const card = buildAgentCard({ self: cardSelf, root, url: `stdio:${root}`, modes: agentModes });
  // Orchestrator role (read once): when set, an incoming task is routed
  // (rules → LLM fallback) to a peer fast-path/delegation instead of a heavy loop.
  const agentRole = card['x-agentmesh']?.role ?? null;

  // Startup self-check: run conformance on own root. Warn by default; refuse under --strict.
  await runSelfCheck(root, strict);

  return {
    async start(input, output) {
      const transport = new NdjsonTransport(input, output, async (message) => {
        const response = await handleMessage({
          message,
          root,
          env,
          card,
          doQueue,
          agentModes,
          agentRole
        });
        if (response) transport.send(response);
      });
      transport.start();
      await new Promise((resolve) => input.on('end', resolve));
    }
  };
}

/**
 * Run conformance check on the served root (startup self-check).
 * Logs warnings to stderr on any fail/warn.
 * Under strict mode, throws if there are any fails (so the caller can exit non-zero).
 * In default (non-strict) mode, any unexpected error is swallowed so startup is never blocked.
 */
async function runSelfCheck(root, strict) {
  let snapshot;
  try {
    snapshot = await buildStandaloneSnapshot(root);
  } catch {
    // Can't build snapshot — skip self-check in default mode; in strict mode still skip
    // (we can't fail-safe without a snapshot) and log a warning.
    process.stderr.write('[agent-mesh] serve-a2a: could not run startup self-check.\n');
    return;
  }

  let report;
  try {
    report = checkConformance(snapshot);
  } catch {
    process.stderr.write('[agent-mesh] serve-a2a: conformance check threw unexpectedly.\n');
    return;
  }

  const hasFail = report.rules.some(r => r.level === 'fail');
  const hasWarn = report.rules.some(r => r.level === 'warn');

  if (hasFail || hasWarn) {
    const lines = ['[agent-mesh] serve-a2a conformance warning:'];
    for (const r of report.rules) {
      if (r.level === 'fail' || r.level === 'warn') {
        lines.push(`  [${r.level.toUpperCase()}] ${r.rule}: ${r.detail}`);
      }
    }
    process.stderr.write(lines.join('\n') + '\n');
  }

  if (strict && hasFail) {
    throw new Error(
      'serve-a2a --strict: conformance failures detected. Fix them or remove --strict to warn-and-serve.'
    );
  }
}

/**
 * Build a minimal snapshot for standalone conformance self-check.
 * Treats the root as both the mesh root and the single-agent folder,
 * using a synthetic manifest entry so checkConformance can run its per-agent rules.
 */
async function buildStandaloneSnapshot(root) {
  // Build a minimal per-agent snapshot for the served root so checkConformance
  // can run anatomy/tools/card/standalone-runnable/version rules standalone.
  // Does NOT require a mesh.json (manifest is set to null).
  const agentName = root.split(/[/\\]/).at(-1) || 'agent';

  // agent.json
  let agentJson = null;
  let agentJsonError = null;
  try {
    agentJson = JSON.parse(await readFile(join(root, 'agent.json'), 'utf8'));
  } catch (err) {
    agentJsonError = err.code === 'ENOENT' ? null : err.message;
  }

  // prompts/system.md
  let systemMdExists = false;
  let systemMdContent = null;
  try {
    systemMdContent = await readFile(join(root, 'prompts', 'system.md'), 'utf8');
    systemMdExists = true;
  } catch { /* absent */ }

  // .mcp.json
  let mcpJson = null;
  try {
    mcpJson = JSON.parse(await readFile(join(root, '.mcp.json'), 'utf8'));
  } catch { /* absent */ }

  // tools/*/server.mjs
  const toolServers = [];
  try {
    const entries = await readdir(join(root, 'tools'), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const serverPath = join(root, 'tools', entry.name, 'server.mjs');
      try { await access(serverPath); toolServers.push(`tools/${entry.name}/server.mjs`); } catch { /* absent */ }
    }
  } catch { /* no tools dir */ }

  // registry.json
  let registryJson = null;
  let registryMarker = null;
  try {
    const raw = await readFile(join(root, 'registry.json'), 'utf8');
    registryJson = JSON.parse(raw);
    registryMarker = registryJson['x-agentmesh-generated'] === true;
  } catch { /* absent */ }

  // Other prompt files
  const generatedPrompts = [];
  for (const relPath of ['prompts/ask.md', 'prompts/do.md']) {
    try {
      const content = await readFile(join(root, relPath), 'utf8');
      generatedPrompts.push({ path: relPath, content });
    } catch { /* absent */ }
  }

  const agentSnapshot = {
    name: agentName,
    root: '.',
    // served:false in standalone snapshot so the enabled-modes rule
    // (served:true → non-empty enabledModes) does not fire for standalone agents
    // that have no mesh policy applied yet.
    served: false,
    enabledModes: [],
    peers: [],
    agentRoot: root,
    agentRootCanonical: root,
    agentJson,
    agentJsonError,
    systemMdExists,
    systemMdContent,
    generatedPrompts,
    mcpJson,
    mcpJsonError: null,
    toolServers,
    registryJson,
    registryMarker
  };

  return {
    meshRoot: root,
    manifest: null,
    manifestError: 'standalone — no mesh.json',
    agents: [agentSnapshot],
    expectedRegistries: null
  };
}

async function handleMessage({ message, root, env, card, doQueue, agentModes, agentRole }) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return rpcError(null, -32600, 'Invalid JSON-RPC request.');
  }

  const { id, method, params } = message;
  if (message.jsonrpc !== '2.0' || typeof method !== 'string') {
    return rpcError(id ?? null, -32600, 'Invalid JSON-RPC request.');
  }

  // A JSON-RPC notification (no id) gets no response and must not trigger a
  // side effect. None of this server's methods are defined as notifications, so
  // a notification for any of them — including SendMessage, which would
  // otherwise spawn an unrequested worker — is dropped before dispatch.
  if (id === undefined) return null;

  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: A2A_PROTOCOL_VERSION,
      agentCard: card,
      capabilities: {}
    });
  }

  if (method === 'ping') {
    return rpcResult(id, {});
  }

  // A2A v1.0 method name. The legacy v0.3.0 `message/send` is NOT aliased — it
  // falls through to the unknown-method JSON-RPC error below.
  if (method === 'SendMessage') {
    const validation = validateMessageSendParams(params);
    if (!validation.ok) {
      // SendMessageResponse is a oneof — the Task is wrapped as { task }.
      return rpcResult(id, {
        task: buildRejectedTask({
          code: 'bad_input',
          message: validation.message,
          requestMessage: params?.message
        })
      });
    }

    const requestedMode = validation.value.input.mode;

    // Layer 1: Capability gate — always enforced when agent.json declares modes.
    if (agentModes !== null && !agentModes.includes(requestedMode)) {
      return rpcResult(id, {
        task: buildRejectedTask({
          code: 'mode_disabled',
          message: `Mode "${requestedMode}" is not in this agent's declared capabilities [${agentModes.join(', ')}].`,
          requestMessage: params?.message
        })
      });
    }

    // Layer 2: Policy gate — only when AGENT_MESH_ENABLED_MODES is present in env.
    const enabledModesEnv = (env || {})['AGENT_MESH_ENABLED_MODES'];
    if (enabledModesEnv !== undefined) {
      const policyModes = enabledModesEnv
        .split(',')
        .map(m => m.trim())
        .filter(m => m.length > 0);
      if (!policyModes.includes(requestedMode)) {
        return rpcResult(id, {
          task: buildRejectedTask({
            code: 'mode_disabled',
            message: `Mode "${requestedMode}" is not enabled by mesh policy (AGENT_MESH_ENABLED_MODES="${enabledModesEnv}").`,
            requestMessage: params?.message
          })
        });
      }
    }

    const started = process.hrtime.bigint();
    // Board correlation: a caller (peer bridge / orchestrator) stamps its run id
    // as agentmesh/parent_run_id; record it so this child's start log links back.
    const parentRunId = validation.value.metadata?.['agentmesh/parent_run_id'] ?? null;
    // Deterministic primary-tool fast-path: a framework-set agentmesh/toolCall
    // runs the declared primaryTool directly (no claude -p). Undeclared/mismatched
    // toolCall → mode_disabled inside the executor. Absent → normal delegation.
    const toolCall = validation.value.metadata?.['agentmesh/toolCall'];

    // Multi-turn peer sessions (§3-§5): for a plain ask delegation, C derives a
    // deterministic per-caller session id and decides resume-vs-new purely from
    // the on-disk transcript — no in-memory state, durable across the bridge's
    // per-call teardown and future runs. Fast-path/orchestrator turns are not
    // multi-turn claude sessions, so they keep session=null (unchanged).
    let session = null;
    if (!toolCall && agentRole !== 'orchestrator' && validation.value.input.mode === 'ask') {
      session = await deriveCallerSession({ root, env, metadata: validation.value.metadata || {} });
    }

    // Per-peer thinking effort (issue #530): threaded via A2A message metadata by
    // the caller's peer bridge (registry-set, never model-arg-injectable).
    const thinkingEffort = validation.value.metadata?.['agentmesh/thinking_effort'];
    const run = toolCall
      ? () => fastPathExecute({ root, env, toolCall, task: validation.value.input.task, parentRunId })
      : agentRole === 'orchestrator'
        ? () => orchestrate({ root, env, input: validation.value.input, parentRunId })
        : () => runAgent({ root, env, input: validation.value.input, parentRunId, session, thinkingEffort });
    const result =
      validation.value.input.mode === 'do'
        ? await runSerialized({ queue: doQueue, run, started })
        : await runWithMetrics({ run, started, queueWaitMs: 0 });

    // Multi-turn observability: stamp the thread's turn count (user_text events
    // in the transcript claude just wrote/extended) into agentmesh/metrics.turn.
    // Best-effort — countTurns returns null on any failure and the metric is
    // simply omitted; there is no live context-fill signal, this is the proxy.
    if (session) {
      const turn = await countTurns(root, session.id, transcriptIo(env));
      if (turn !== null) result.metrics.turn = turn;
      // Both reads open the same transcript file; coalescing is not worth the
      // coupling — each is best-effort ms against a seconds-to-minutes task window.
      // Spec 2026-06-12 §3.3: additive, best-effort thread headroom — same
      // posture as metrics.turn; absent signal → field omitted, never an error.
      const h = await readSessionHeadroom(root, session.id, {
        ...transcriptIo(env),
        contextWindow: readPositiveInt(env.AGENT_MESH_CONTEXT_WINDOW, DEFAULT_CONTEXT_WINDOW)
      }).catch(() => null);
      if (h) result.metrics.headroom = h.headroomPct;
    }

    return rpcResult(id, {
      task: buildTaskFromDelegateResult({
        result: result.result,
        message: validation.value.message,
        metrics: result.metrics
      })
    });
  }

  return rpcError(id, -32601, `Unknown method: ${method}`);
}

/**
 * Derive C's deterministic per-caller session for an ask turn (spec §3.2-§3.4).
 * Caller identity is the authentic, framework-set `agentmesh/caller` (never a model
 * arg → anti-spoof, §3.5); `epoch` is a per-caller counter persisted on C so
 * `new_conversation` resets the thread durably across runs. `resume` is decided
 * only by whether the transcript already exists on disk — so the right thread is
 * continued even after the bridge tears C down per call. Returns { id, resume }.
 */
// Test-only seam: AGENT_MESH_PROJECTS_DIR redirects the ~/.claude/projects lookup
// so transcript existence/turn-count are hermetic in tests (mirrors
// AGENT_MESH_TEST_PLATFORM). Operator-set env only — never model-influenced.
function transcriptIo(env) {
  const platform = env?.AGENT_MESH_TEST_PLATFORM || process.platform;
  return env?.AGENT_MESH_PROJECTS_DIR
    ? { projectsDir: env.AGENT_MESH_PROJECTS_DIR, platform }
    : { platform };
}

async function deriveCallerSession({ root, env, metadata }) {
  const caller = typeof metadata['agentmesh/caller'] === 'string' && metadata['agentmesh/caller']
    ? metadata['agentmesh/caller'] : '_anon';
  let epoch = await readEpoch(root, caller);
  if (metadata['agentmesh/reset_conversation'] === true) {
    epoch += 1;
    try { await persistEpoch(root, caller, epoch); }
    catch (e) { process.stderr.write(`[agent-mesh] persistEpoch failed for ${caller}: ${e.message}\n`); }
  }
  const io = transcriptIo(env);
  const platform = io.platform || process.platform;
  const encoded = encodeProjectDir(await realpath(root), platform, io);
  const id = deriveSessionId(`${caller}:${epoch}`, encoded);
  const resume = await transcriptExists(root, id, io).catch(() => false);
  // Best-effort dashboard naming (§3.1, §7): the label/event STORE is keyed by the
  // mesh root (what the dashboard reads), with agentRoot identifying the owning
  // agent. Fall back to the agent root only for a standalone peer (no mesh env).
  // normalize() + trailing-separator strip before dirname: a MESH_ROOT env
  // override of "/mesh/path/" would otherwise dirname to itself and silently
  // key a store the dashboard never reads.
  const rawMeshDir = env?.AGENT_MESH_MESH_ROOT
    ? normalize(env.AGENT_MESH_MESH_ROOT).replace(/[\\/]+$/, '')
    : null;
  const meshRoot = env?.AGENT_MESH_MESH_CEILING
    || (rawMeshDir ? dirname(rawMeshDir) : null);
  const labelRoot = meshRoot || root;
  try {
    await setLabel(labelRoot, id, `from:${caller}`);
    await recordEvent(labelRoot, { kind: 'create', source: `peer:${caller}`, sessionId: id, agentRoot: root });
  } catch { /* ignore — naming is cosmetic */ }
  return { id, resume };
}

async function runSerialized({ queue, run, started }) {
  const queuedAt = process.hrtime.bigint();
  return queue.run(async () => {
    const queueWaitMs = elapsedMs(queuedAt);
    return runWithMetrics({ run, started, queueWaitMs });
  });
}

async function runWithMetrics({ run, started, queueWaitMs }) {
  const workerStarted = process.hrtime.bigint();
  const result = await run();
  // Token/cost accounting parsed by delegate.js from the worker's result envelope
  // (null when the output wasn't a parseable envelope, e.g. timeout/error). Rides
  // the existing metrics block so a caller reads cost the same way it reads latency.
  const u = result?.usage || null;
  return {
    result,
    metrics: {
      queue_wait_ms: queueWaitMs,
      worker_spawn_ms: 0,
      worker_run_ms: elapsedMs(workerStarted),
      change_detect_ms: 0,
      total_ms: elapsedMs(started),
      isolation_violations: 0,
      recursion_refusals: result?.status === 'refused' ? { [result.error?.code || 'internal']: 1 } : {},
      conformance: 'not_run',
      tokens_in: u?.input_tokens ?? null,
      tokens_out: u?.output_tokens ?? null,
      tokens_cache_read: u?.cache_read_input_tokens ?? null,
      tokens_cache_creation: u?.cache_creation_input_tokens ?? null,
      cost_usd: u?.total_cost_usd ?? null,
      downstream_cost_usd: result?.downstream_cost_usd ?? null,
      num_turns: u?.num_turns ?? null,
      api_ms: u?.duration_api_ms ?? null
    }
  };
}

function elapsedMs(start) {
  // Convert to Number BEFORE dividing — BigInt division truncates toward zero,
  // which would zero out every sub-millisecond duration and drop fractional ms.
  return Number(process.hrtime.bigint() - start) / 1e6;
}

class NdjsonTransport {
  constructor(input, output, onMessage) {
    this.input = input;
    this.output = output;
    this.onMessage = onMessage;
    this.buffer = '';
  }

  start() {
    // setEncoding holds back partial multi-byte UTF-8 sequences across chunk
    // boundaries (StringDecoder), so a non-ASCII char split between two stdin
    // chunks is not corrupted into U+FFFD. Per-chunk chunk.toString('utf8')
    // would decode each half independently and lose the character.
    this.input.setEncoding('utf8');
    this.input.on('data', (chunk) => {
      this.buffer += chunk;
      // Bound pre-parse buffering: a frame with no newline that exceeds the cap
      // is dropped (and reported) rather than grown without limit.
      if (this.buffer.length > MAX_LINE_CHARS && this.buffer.indexOf('\n') === -1) {
        this.buffer = '';
        this.send(rpcError(null, -32700, 'Frame exceeds maximum length.'));
        return;
      }
      this.drain();
    });
  }

  send(message) {
    this.output.write(`${JSON.stringify(message)}\n`);
  }

  drain() {
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.dispatch(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  dispatch(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.send(rpcError(null, -32700, 'Parse error.'));
      return;
    }

    this.onMessage(message).catch((error) => {
      const id = message && typeof message === 'object' ? message.id : null;
      this.send(rpcError(id ?? null, -32603, error.message));
    });
  }
}
