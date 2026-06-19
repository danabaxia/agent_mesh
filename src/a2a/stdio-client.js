import { spawn } from 'node:child_process';
import { MAX_LINE_CHARS } from '../config.js';
import { normalizeRegistry } from './registry.js';
import { HttpClientSession } from './http-client.js';

// A client-side ceiling so a peer that stays alive but never replies (a dropped
// or corrupted response frame) cannot wedge the caller forever. It sits ABOVE
// the server's own per-task timeout (default 600s), which always returns a Task
// — so this only fires on genuine transport-level loss, not slow tasks.
const DEFAULT_REQUEST_TIMEOUT_MS = 660_000;

// Grace before a peer that ignores stdin EOF is force-killed during close().
const CLOSE_GRACE_MS = 5_000;

// Recursion/identity state must come only from the spawned server's own
// threaded env, never from operator-authored registry data — a peer.env that
// reset these would erase cycle detection / depth budget for that subtree.
const PROTECTED_ENV = ['AGENT_MESH_PATH', 'AGENT_MESH_DEPTH'];

export async function createA2AClient(registry, options = {}) {
  const peers = await normalizeRegistry(registry);
  const sessions = new Map();
  const env = options.env || process.env;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  // Extra env keys (beyond PROTECTED_ENV) that the operator-authored registry
  // `peer.env` must NOT be able to override. The framework peer bridge passes
  // the security-relevant set (mode, mesh-root, ceiling) here so a registry
  // entry cannot escalate mode or redirect the obeyed mesh layer / ceiling.
  const protectedEnv = Array.isArray(options.protectedEnv) ? options.protectedEnv : [];

  return {
    async send(peerName, message) {
      const session = getSession({ peerName, peers, sessions, env, requestTimeoutMs, protectedEnv });
      // A2A v1.0: method is `SendMessage`; SendMessageResponse is a oneof and a
      // non-streaming reply wraps the Task as { task } — unwrap it so callers
      // keep receiving a bare A2A Task.
      const response = await session.request('SendMessage', { message });
      return response.result?.task ?? null;
    },
    async initialize(peerName) {
      const session = getSession({ peerName, peers, sessions, env, requestTimeoutMs, protectedEnv });
      const response = await session.request('initialize', {});
      return response.result;
    },
    async close() {
      await Promise.all([...sessions.values()].map((session) => session.close()));
      sessions.clear();
    }
  };
}

function getSession({ peerName, peers, sessions, env, requestTimeoutMs, protectedEnv }) {
  const peer = peers[peerName];
  if (!peer) throw new Error(`Unknown A2A peer: ${peerName}`);
  if (!sessions.has(peerName)) {
    const session = peer.type === 'http'
      ? new HttpClientSession(peer, env, requestTimeoutMs)
      : new StdioClientSession(peer, env, requestTimeoutMs, protectedEnv);
    sessions.set(peerName, session);
  }
  return sessions.get(peerName);
}

class StdioClientSession {
  constructor(peer, baseEnv, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, protectedEnv = []) {
    this.peer = peer;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.closed = false;
    this.requestTimeoutMs = requestTimeoutMs;
    this.protectedEnv = protectedEnv;
    this.child = spawn(peer.command, peer.args, {
      cwd: peer.root || process.cwd(),
      env: peerEnv(baseEnv, peer.env, protectedEnv),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.onData(chunk));
    // Drain stderr so a chatty/synchronous peer cannot block on a full OS pipe
    // buffer; keep a bounded tail to enrich the exit error message.
    this.stderrTail = '';
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4000);
    });
    this.child.on('error', (error) => this.rejectAll(error));
    this.child.on('close', (code, signal) => {
      this.closed = true;
      const detail = this.stderrTail.trim() ? `: ${this.stderrTail.trim()}` : '';
      this.rejectAll(new Error(`A2A peer "${peer.name}" exited (${code ?? signal})${detail}`));
    });
  }

  request(method, params) {
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = this.requestTimeoutMs
        ? setTimeout(() => {
            if (!this.pending.delete(id)) return;
            reject(new Error(`A2A request "${method}" to "${this.peer.name}" timed out after ${this.requestTimeoutMs}ms.`));
          }, this.requestTimeoutMs)
        : null;
      timer?.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (error) {
          if (timer) clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    }).then((response) => {
      if (response.error) throw new Error(response.error.message);
      return response;
    });
  }

  async close() {
    if (this.closed) return;
    if (!this.child.killed) this.child.stdin.end();
    await new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      // A peer that doesn't exit on stdin EOF must not hang shutdown forever:
      // escalate to a tree kill, then resolve regardless.
      const timer = setTimeout(() => {
        try {
          if (this.child.pid) process.kill(-this.child.pid, 'SIGKILL');
        } catch {
          try {
            this.child.kill('SIGKILL');
          } catch {
            // already gone
          }
        }
        resolve();
      }, CLOSE_GRACE_MS);
      timer.unref?.();
      this.child.once('close', done);
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    // Drop an oversized newline-less frame instead of buffering it unbounded.
    if (this.buffer.length > MAX_LINE_CHARS && this.buffer.indexOf('\n') === -1) {
      this.buffer = '';
      return;
    }
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
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve(message);
  }

  rejectAll(error) {
    for (const { reject, timer } of this.pending.values()) {
      if (timer) clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }
}

// Merge operator-authored peer.env over the base env, but never let it override
// the recursion/identity vars the spawned server reads from its own env.
function peerEnv(baseEnv, overrides, protectedEnv = []) {
  const merged = { ...baseEnv, ...(overrides || {}) };
  // Built-in PROTECTED_ENV (recursion identity/budget) plus any caller-supplied
  // reserved keys (the peer bridge passes AGENT_MESH_MODE/MESH_ROOT/MESH_CEILING)
  // are taken authoritatively from the base env and can never be overridden by an
  // operator-authored registry `peer.env`.
  for (const key of [...PROTECTED_ENV, ...protectedEnv]) {
    if (key in baseEnv) merged[key] = baseEnv[key];
    else delete merged[key];
  }
  return merged;
}
