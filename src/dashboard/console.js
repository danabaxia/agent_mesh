/**
 * src/dashboard/console.js
 *
 * The Desk console broker (shell) — the one place the dashboard *runs* an agent.
 *
 * A browser POST is brokered into a real A2A `SendMessage` against a
 * `served:true` agent, spawning its `serve-a2a` from a **managed dashboard
 * *caller* registry** (a marker-validated registry of every served agent's own
 * spawn entry — NOT an agent's peer `registry.json`, which lists peers, not
 * itself). The runtime contract is unchanged: `SendMessage` returns exactly one
 * final `Task`, so the console is request → final-Task in v1.
 *
 * Safety properties enforced here (spec §3 Console):
 *  - **ask-only.** `do` would let model output write under the agent root,
 *    breaking the read-only-dashboard promise. Any non-`ask` mode is rejected
 *    with `mode_disabled` BEFORE any spawn.
 *  - **served-only.** Refuses a target that is not `served:true`.
 *  - **marker-validated registry.** Refuses to spawn from a stale/markerless
 *    caller registry.
 *  - **resource limits.** Body cap (≤ MAX_TASK_CHARS, enforced at the route),
 *    per-mesh concurrency cap with a queue, one in-flight send per agent
 *    (serialized, mirroring the runtime's per-folder serialization), and
 *    cleanup on client disconnect (the brokered client/process is killed when
 *    the HTTP request is abandoned).
 */

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { readManifest } from '../builder/manifest.js';
import { createA2AClient } from '../a2a/stdio-client.js';
import { MAX_TASK_CHARS } from '../config.js';

// Default bin path: resolve ../../bin/agent-mesh.js relative to this module.
const DEFAULT_BIN = fileURLToPath(new URL('../../bin/agent-mesh.js', import.meta.url));

const CONSOLE_MODE = 'ask';
const DEFAULT_CONCURRENCY = 2;

// ---------------------------------------------------------------------------
// ConsoleError — typed, carries a stable `.code` the route maps to a response.
// ---------------------------------------------------------------------------

export class ConsoleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConsoleError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// generateCallerRegistry — pure
// ---------------------------------------------------------------------------

/**
 * Build the dashboard *caller* registry from the manifest: one spawn entry per
 * `served:true` agent, keyed by the agent's own name (so the dashboard can spawn
 * it directly). Carries the same projected env as a peer registry entry so the
 * spawned `serve-a2a` enforces the same enabled-mode / mesh-ceiling policy.
 *
 * @param {object} manifest  parsed mesh.json
 * @param {{ meshRootAbs: string, binPath: string }} opts
 * @returns {{ 'x-agentmesh-generated': true, peers: object }}
 */
export function generateCallerRegistry(manifest, { meshRootAbs, binPath }) {
  const peers = {};
  for (const agent of (manifest?.agents ?? [])) {
    if (agent.served !== true) continue;
    const absRoot = join(meshRootAbs, agent.root);
    peers[agent.name] = {
      root: absRoot,
      command: 'node',
      args: [binPath, 'serve-a2a', absRoot],
      cwd: absRoot,
      env: {
        AGENT_MESH_ENABLED_MODES: (agent.enabledModes || []).join(','),
        AGENT_MESH_MESH_ROOT: join(meshRootAbs, 'mesh'),
        AGENT_MESH_MESH_CEILING: meshRootAbs
      }
    };
  }
  return { 'x-agentmesh-generated': true, peers };
}

// ---------------------------------------------------------------------------
// deriveDelegations — pure
// ---------------------------------------------------------------------------

/**
 * Derive the post-hoc delegation summary from a returned Task's metadata.
 * v1 surfaces what the runtime already reports (log path, changed files,
 * metrics); the live "lighting" of onward edges is a v2 nicety, not a fabricated
 * v1 stream.
 *
 * @param {object} task  A2A Task
 * @returns {{ logPath: string, filesChanged: string[]|null, metrics: object }}
 */
export function deriveDelegations(task) {
  const md = task?.metadata ?? {};
  return {
    logPath: md['agentmesh/log_path'] || '',
    filesChanged: md['agentmesh/files_changed'] ?? null,
    metrics: md['agentmesh/metrics'] ?? {}
  };
}

// ---------------------------------------------------------------------------
// Concurrency primitives
// ---------------------------------------------------------------------------

/**
 * A counting limiter: at most `max` tasks run concurrently; the rest queue in
 * FIFO order. Each task is a `() => Promise`. Returns a function that schedules
 * a task and resolves/rejects with its result.
 */
function makeLimiter(max) {
  let active = 0;
  const queue = [];

  const pump = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--;
        pump();
      });
  };

  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      pump();
    });
}

// ---------------------------------------------------------------------------
// createConsoleBroker — shell
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 *   @param {string}  opts.meshRoot            absolute mesh root
 *   @param {string}  [opts.binPath]           path to bin/agent-mesh.js
 *   @param {number}  [opts.concurrency]       per-mesh concurrency cap (default 2)
 *   @param {number}  [opts.requestTimeoutMs]  client request timeout (pass-through)
 *   @param {Function}[opts.createClient]      injectable A2A client factory (tests)
 * @returns {{ send(args): Promise<object>, close(): Promise<void> }}
 */
export function createConsoleBroker({
  meshRoot,
  binPath = DEFAULT_BIN,
  concurrency = DEFAULT_CONCURRENCY,
  requestTimeoutMs,
  createClient = createA2AClient
} = {}) {
  if (!meshRoot) throw new Error('createConsoleBroker requires meshRoot');

  // Per-mesh concurrency cap (FIFO queue) and per-agent serialization (one
  // in-flight per agent). Acquire the per-agent lock FIRST so a queued send to a
  // busy agent never occupies a scarce global slot while it waits its turn.
  const meshLimiter = makeLimiter(Math.max(1, concurrency));
  const agentLimiters = new Map(); // agentName → limiter(1)

  function agentLimiter(name) {
    let lim = agentLimiters.get(name);
    if (!lim) {
      lim = makeLimiter(1);
      agentLimiters.set(name, lim);
    }
    return lim;
  }

  /**
   * Broker a single message to one agent.
   *
   * @param {object} args
   *   @param {string} args.agentName
   *   @param {string} args.text
   *   @param {string} [args.mode]    defaults to 'ask'
   *   @param {AbortSignal} [args.signal]  aborts the in-flight spawn on disconnect
   * @returns {Promise<{ task: object, delegations: object }>}
   */
  async function send({ agentName, text, mode = CONSOLE_MODE, signal }) {
    // --- Gate 1: ask-only (before any spawn) ---
    if (mode !== CONSOLE_MODE) {
      throw new ConsoleError(
        'mode_disabled',
        `Console is ask-only; mode "${mode}" is disabled from the dashboard.`
      );
    }

    // --- Gate 2: input shape ---
    if (typeof agentName !== 'string' || agentName.length === 0) {
      throw new ConsoleError('bad_input', 'agent name is required.');
    }
    if (typeof text !== 'string' || text.trim().length < 1) {
      throw new ConsoleError('bad_input', 'message text is required.');
    }
    if (text.length > MAX_TASK_CHARS) {
      throw new ConsoleError(
        'bad_input',
        `message exceeds the ${MAX_TASK_CHARS}-character limit.`
      );
    }

    // --- Load + validate the caller registry (fresh from mesh.json) ---
    let manifest;
    try {
      manifest = await readManifest(meshRoot);
    } catch (err) {
      throw new ConsoleError('stale_registry', `cannot read mesh.json: ${err.message}`);
    }

    const registry = generateCallerRegistry(manifest, { meshRootAbs: meshRoot, binPath });
    if (registry['x-agentmesh-generated'] !== true) {
      throw new ConsoleError(
        'stale_registry',
        'caller registry is missing its generation marker; refusing to spawn.'
      );
    }

    // --- Gate 3: target must exist and be served:true ---
    const target = (manifest.agents ?? []).find((a) => a.name === agentName);
    if (!target) {
      throw new ConsoleError('bad_input', `unknown agent "${agentName}".`);
    }
    if (target.served !== true) {
      throw new ConsoleError(
        'not_served',
        `agent "${agentName}" is not served (served:false); the console cannot spawn it.`
      );
    }
    if (!registry.peers[agentName]) {
      // Defensive: served target with no spawn entry → treat as stale.
      throw new ConsoleError(
        'stale_registry',
        `no caller-registry spawn entry for served agent "${agentName}".`
      );
    }

    // --- Run, serialized per agent then bounded by the mesh-wide cap ---
    return agentLimiter(agentName)(() =>
      meshLimiter(() => spawnAndSend({ registry, agentName, text, signal, requestTimeoutMs, createClient }))
    );
  }

  async function close() {
    // Brokered clients are created and closed per-send; nothing long-lived to
    // tear down here. Present for symmetry / future pooling.
  }

  return { send, close };
}

// ---------------------------------------------------------------------------
// spawnAndSend — one isolated client per send, killed on abort/finally.
// ---------------------------------------------------------------------------

async function spawnAndSend({ registry, agentName, text, signal, requestTimeoutMs, createClient }) {
  if (signal?.aborted) {
    throw new ConsoleError('aborted', 'request aborted before send.');
  }

  let client;
  try {
    client = await createClient(registry, { env: process.env, requestTimeoutMs });
  } catch (err) {
    throw new ConsoleError('spawn_failed', `failed to spawn agent "${agentName}": ${err.message}`);
  }

  // Wire disconnect → close (kills the spawned process tree).
  let onAbort = null;
  if (signal) {
    onAbort = () => { client.close().catch(() => {}); };
    signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const message = {
      messageId: randomUUID(),
      role: 'ROLE_USER',
      parts: [{ text }],
      metadata: { 'agentmesh/mode': CONSOLE_MODE }
    };
    const task = await client.send(agentName, message);
    if (signal?.aborted) {
      throw new ConsoleError('aborted', 'request aborted during send.');
    }
    return { task, delegations: deriveDelegations(task) };
  } catch (err) {
    if (err instanceof ConsoleError) throw err;
    if (signal?.aborted) throw new ConsoleError('aborted', 'request aborted during send.');
    throw new ConsoleError('spawn_failed', err.message);
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    await client.close().catch(() => {});
  }
}
