import { randomUUID } from 'node:crypto';
import { MAX_TASK_CHARS } from '../config.js';

export const A2A_PROTOCOL_VERSION = '1.0';
export const FRAMEWORK_VERSION = '0.2.0';

// A2A v1.0 TaskState enum values (ProtoJSON SCREAMING_SNAKE_CASE).
export const TASK_STATES = new Set([
  'TASK_STATE_SUBMITTED',
  'TASK_STATE_WORKING',
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_COMPLETED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_FAILED',
  'TASK_STATE_REJECTED',
  'TASK_STATE_AUTH_REQUIRED'
]);

export const ERROR_CODES = new Set([
  'bad_input',
  'cycle',
  'depth_budget',
  'boundary_denied',
  'readonly_parent',
  'mode_disabled',
  'spawn_failed',
  'internal'
]);

export function validateMessageSendParams(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return { ok: false, message: 'SendMessage params must be an object.' };
  }

  const message = params.message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return { ok: false, message: 'params.message must be an object.' };
  }

  const metadata = objectOrEmpty(message.metadata);
  const mode = metadata['agentmesh/mode'];
  if (mode !== 'ask' && mode !== 'do') {
    return { ok: false, message: 'message.metadata["agentmesh/mode"] must be "ask" or "do".' };
  }

  const task = extractText(message.parts);
  if (typeof task !== 'string' || task.length < 1 || task.length > MAX_TASK_CHARS) {
    return {
      ok: false,
      message: `message.parts must contain text between 1 and ${MAX_TASK_CHARS} characters.`
    };
  }

  return {
    ok: true,
    value: {
      message,
      input: { mode, task },
      metadata
    }
  };
}

export function buildTaskFromDelegateResult({ result, message, id = randomUUID(), metrics = {} }) {
  const errorCode = result?.error?.code;
  const state = delegateStatusToTaskState(result?.status);
  const metadata = {
    'agentmesh/framework_version': FRAMEWORK_VERSION,
    'agentmesh/files_changed': result?.files_changed ?? null,
    'agentmesh/log_path': result?.log_path || '',
    'agentmesh/metrics': normalizeMetrics(metrics)
  };
  // Run id locates this run's records inside the grouped per-date log file.
  if (result?.run_id) metadata['agentmesh/run_id'] = result.run_id;

  if (result?.preexisting_dirty) metadata['agentmesh/preexisting_dirty'] = true;
  if (errorCode) metadata['agentmesh/error_code'] = normalizeErrorCode(errorCode);
  // Timeouts have no result.error.code — without this, the a2a audit log
  // records status=failed with error_code=null and timeouts are
  // indistinguishable from other failures (observed 2026-06-12, 613s run).
  else if (result?.status === 'timeout') metadata['agentmesh/error_code'] = 'timeout';
  if (result?.best_effort) metadata['agentmesh/best_effort'] = true;
  if (result?.note) metadata['agentmesh/note'] = result.note;
  if (result?.downstream_changes != null) metadata['agentmesh/downstream_changes'] = result.downstream_changes;

  const artifacts = [];
  if (typeof result?.summary === 'string' && result.summary.length > 0) {
    artifacts.push({
      artifactId: `${id}-summary`,
      name: 'summary',
      // v1.0 parts are discriminated by member name (text/data/file), no `kind`.
      parts: [{ text: result.summary }]
    });
  }

  return {
    id,
    contextId: message?.contextId || message?.messageId || id,
    status: {
      state,
      message: buildStatusMessage(result),
      timestamp: new Date().toISOString()
    },
    artifacts,
    metadata
  };
}

export function buildRejectedTask({ code, message, requestMessage, id = randomUUID(), metrics = {} }) {
  return buildTaskFromDelegateResult({
    id,
    message: requestMessage,
    metrics,
    result: {
      status: 'refused',
      summary: '',
      files_changed: null,
      log_path: '',
      error: { code, message }
    }
  });
}

export function buildAgentCard({ self, root, url, modes, transport = 'stdio' }) {
  const capabilities = Array.isArray(self?.capabilities) ? self.capabilities : [];
  // Use explicitly passed modes, else fall back to agent.json x-agentmesh.modes, else default.
  const agentModes =
    Array.isArray(modes) && modes.length > 0
      ? modes
      : Array.isArray(self?.['x-agentmesh']?.modes) && self['x-agentmesh'].modes.length > 0
        ? self['x-agentmesh'].modes
        : ['ask', 'do'];
  const xAgentmesh = {
    root,
    modes: agentModes
  };
  // Discovery for the orchestrator: expose a SANITIZED primaryTool (server, tool,
  // bounded intents, argsSchema shape) — never command/args/paths — so routing
  // can be done from the card via `initialize`, not by scraping peer roots.
  const role = self?.['x-agentmesh']?.role;
  if (role) xAgentmesh.role = role;
  const sanitized = sanitizePrimaryTool(self?.['x-agentmesh']?.primaryTool);
  if (sanitized) xAgentmesh.primaryTool = sanitized;

  return {
    name: self?.name || 'agent-mesh',
    description: self?.description || '',
    version: FRAMEWORK_VERSION,
    // v1.0: top-level protocolVersion/url/preferredTransport are replaced by an
    // ordered supportedInterfaces list (first entry = preferred). STDIO is a
    // custom protocol binding (open-form string per spec §5.8); HTTP uses JSONRPC.
    supportedInterfaces: [
      {
        url,
        protocolBinding: transport === 'http' ? 'JSONRPC' : 'STDIO',
        protocolVersion: A2A_PROTOCOL_VERSION
      }
    ],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
      extendedAgentCard: false
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: [
      {
        id: 'delegate',
        name: 'Delegate task',
        description: self?.description || 'Delegate a scoped task to this folder agent.',
        tags: ['agent-mesh', ...capabilities]
      }
    ],
    securitySchemes: {},
    'x-agentmesh': xAgentmesh
  };
}

const MAX_INTENTS = 12;
const MAX_INTENT_CHARS = 60;

// Expose only safe, bounded fields of a declared primaryTool. Never command,
// args, env, or paths — those stay local to the agent.
function sanitizePrimaryTool(pt) {
  if (!pt || typeof pt !== 'object' || typeof pt.tool !== 'string' || typeof pt.server !== 'string') {
    return null;
  }
  const out = { server: pt.server, tool: pt.tool };
  if (Array.isArray(pt.intents)) {
    out.intents = pt.intents
      .filter((s) => typeof s === 'string')
      .slice(0, MAX_INTENTS)
      .map((s) => s.slice(0, MAX_INTENT_CHARS));
  }
  if (pt.argsSchema && typeof pt.argsSchema === 'object' && !Array.isArray(pt.argsSchema)) {
    out.argsSchema = pt.argsSchema;
  }
  return out;
}

export function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

export function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function extractText(parts) {
  if (!Array.isArray(parts)) return '';
  // v1.0 parts are discriminated by member name: a text part is { text: "..." }.
  return parts
    .filter((part) => part && typeof part === 'object' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

function delegateStatusToTaskState(status) {
  if (status === 'done') return 'TASK_STATE_COMPLETED';
  if (status === 'refused') return 'TASK_STATE_REJECTED';
  if (status === 'timeout' || status === 'error') return 'TASK_STATE_FAILED';
  return 'TASK_STATE_FAILED';
}

function buildStatusMessage(result) {
  const text = result?.error?.message || result?.summary || '';
  return {
    role: 'ROLE_AGENT',
    parts: [{ text }]
  };
}

function normalizeErrorCode(code) {
  return ERROR_CODES.has(code) ? code : 'internal';
}

function normalizeMetrics(metrics) {
  const out = {
    frameworkVersion: FRAMEWORK_VERSION,
    queue_wait_ms: numberOrZero(metrics.queue_wait_ms),
    worker_spawn_ms: numberOrZero(metrics.worker_spawn_ms),
    worker_run_ms: numberOrZero(metrics.worker_run_ms),
    change_detect_ms: numberOrZero(metrics.change_detect_ms),
    total_ms: numberOrZero(metrics.total_ms),
    isolation_violations: numberOrZero(metrics.isolation_violations),
    recursion_refusals: metrics.recursion_refusals || {},
    conformance: metrics.conformance || 'not_run'
  };
  // Multi-turn observability (multi-turn spec §4/§6): thread turn-count from
  // the resumed transcript. Present only when the server could count it —
  // omitted otherwise, so single-shot response payloads are unchanged.
  if (metrics.turn !== undefined) out.turn = numberOrZero(metrics.turn);
  // Spec 2026-06-12 §3.3: context headroom percent — present only when the
  // server read a usage signal from the transcript tail;
  // omitted otherwise, so single-shot response payloads are unchanged.
  if (metrics.headroom !== undefined) out.headroom = numberOrZero(metrics.headroom);
  // Cross-hop cost rollup (issue #315): expose own hop cost and the full subtree
  // cost so callers can read the delegation chain total from the root Task without
  // correlating N run-log directories. Omitted when no usage data was parsed.
  if (metrics.cost_usd != null) out.cost_usd = numberOrNull(metrics.cost_usd);
  const ownCost = metrics.cost_usd != null ? numberOrNull(metrics.cost_usd) : null;
  const downstreamCost = metrics.downstream_cost_usd != null ? numberOrNull(metrics.downstream_cost_usd) : null;
  if (ownCost !== null || downstreamCost !== null) {
    out.subtree_cost_usd = (ownCost ?? 0) + (downstreamCost ?? 0);
  }
  return out;
}

function numberOrNull(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function numberOrZero(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function objectOrEmpty(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}
