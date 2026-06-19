import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_DEPTH, MAX_LINE_CHARS } from '../config.js';
import { delegateTask } from '../delegate.js';
import { describeFolder } from '../description.js';
import { SerialQueue } from '../lock.js';
import {
  A2A_PROTOCOL_VERSION,
  buildAgentCard,
  buildRejectedTask,
  buildTaskFromDelegateResult,
  rpcError,
  rpcResult,
  validateMessageSendParams
} from './protocol.js';

const DEFAULT_PORT = 4747;
const DEFAULT_HOST = '127.0.0.1';

// Request headers used to thread the caller's recursion env across the HTTP
// transport boundary (stdio uses process.env inheritance; HTTP uses headers).
const RECURSION_ENV = {
  'x-agentmesh-path': 'AGENT_MESH_PATH',
  'x-agentmesh-depth': 'AGENT_MESH_DEPTH'
};

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

export async function createA2AHttpServer({ root, port = DEFAULT_PORT, host = DEFAULT_HOST, env = process.env }) {
  const self = await describeFolder(root);
  const doQueue = new SerialQueue();
  const agentModes = await readAgentModes(root);
  let agentXa = null;
  try {
    agentXa = JSON.parse(await readFile(join(root, 'agent.json'), 'utf8'))?.['x-agentmesh'] ?? null;
  } catch { /* no agent.json */ }
  const cardSelf = agentXa ? { ...self, 'x-agentmesh': agentXa } : self;
  const serverUrl = `http://${host}:${port}`;
  const card = buildAgentCard({ self: cardSelf, root, url: serverUrl, modes: agentModes, transport: 'http' });

  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rpcError(null, -32700, 'Only POST is supported.')));
      return;
    }

    // Merge per-request recursion env from headers into the server env.
    // This lets the HTTP server enforce the same cycle/depth budget as the
    // stdio server (which gets these via inherited process.env from the spawner).
    const requestEnv = { ...env };
    for (const [header, envKey] of Object.entries(RECURSION_ENV)) {
      const val = req.headers[header];
      if (val === undefined) continue;
      if (envKey === 'AGENT_MESH_DEPTH') {
        // Cap incoming depth to the server's own configured maximum so an
        // untrusted HTTP caller cannot expand the recursion budget by injecting
        // an inflated X-AgentMesh-Depth header (same invariant as the stdio
        // path where PROTECTED_ENV blocks peer.env overrides).
        const serverRaw = parseInt(env.AGENT_MESH_DEPTH, 10);
        const serverMax = Number.isFinite(serverRaw) && serverRaw >= 0 ? serverRaw : DEFAULT_DEPTH;
        const incoming = parseInt(val, 10);
        requestEnv[envKey] = String(Number.isFinite(incoming) && incoming >= 0 ? Math.min(incoming, serverMax) : serverMax);
      } else {
        requestEnv[envKey] = val;
      }
    }

    let body = '';
    try {
      for await (const chunk of req) {
        body += chunk;
        if (body.length > MAX_LINE_CHARS) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(rpcError(null, -32700, 'Request body too large.')));
          return;
        }
      }
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rpcError(null, -32700, 'Failed to read request body.')));
      return;
    }

    let message;
    try {
      message = JSON.parse(body);
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rpcError(null, -32700, 'Parse error.')));
      return;
    }

    let response;
    try {
      response = await handleMessage({ message, root, env: requestEnv, card, doQueue, agentModes });
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rpcError(null, -32603, err.message)));
      return;
    }

    // JSON-RPC notifications (id === undefined) produce null from handleMessage —
    // return an empty 204 rather than writing "null".
    if (response === null) {
      res.writeHead(204);
      res.end();
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    }
  });

  return {
    get url() { return serverUrl; },

    async start() {
      await new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      return { url: serverUrl };
    },

    async close() {
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  };
}

async function handleMessage({ message, root, env, card, doQueue, agentModes }) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return rpcError(null, -32600, 'Invalid JSON-RPC request.');
  }

  const { id, method, params } = message;
  if (message.jsonrpc !== '2.0' || typeof method !== 'string') {
    return rpcError(id ?? null, -32600, 'Invalid JSON-RPC request.');
  }

  // JSON-RPC notifications (no id) get no response.
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

  if (method === 'SendMessage') {
    const validation = validateMessageSendParams(params);
    if (!validation.ok) {
      return rpcResult(id, {
        task: buildRejectedTask({
          code: 'bad_input',
          message: validation.message,
          requestMessage: params?.message
        })
      });
    }

    const requestedMode = validation.value.input.mode;

    // Capability gate: agent.json-declared modes.
    if (agentModes !== null && !agentModes.includes(requestedMode)) {
      return rpcResult(id, {
        task: buildRejectedTask({
          code: 'mode_disabled',
          message: `Mode "${requestedMode}" is not in this agent's declared capabilities [${agentModes.join(', ')}].`,
          requestMessage: params?.message
        })
      });
    }

    // Policy gate: AGENT_MESH_ENABLED_MODES env (from mesh policy).
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
    const run = () => delegateTask({ root, env, input: validation.value.input });
    const result = validation.value.input.mode === 'do'
      ? await runSerialized({ queue: doQueue, run, started })
      : await runWithMetrics({ run, started, queueWaitMs: 0 });

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
      num_turns: u?.num_turns ?? null,
      api_ms: u?.duration_api_ms ?? null
    }
  };
}

function elapsedMs(start) {
  return Number(process.hrtime.bigint() - start) / 1e6;
}
