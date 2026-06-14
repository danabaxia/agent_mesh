/**
 * src/mcp-client.js
 *
 * Minimal MCP stdio client (shell) — spawns a tool server, runs the
 * `initialize` → `tools/call` handshake over newline-delimited JSON-RPC (the same
 * framing `src/mcp.js` emits), returns the tool result text, and tears the server
 * down. Used by the deterministic primary-tool fast-path to call an agent's own
 * `readOnly` MCP tool directly — no `claude -p` worker.
 */

import { spawn } from 'node:child_process';
import { MAX_LINE_CHARS } from './config.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const CLOSE_GRACE_MS = 3_000;

/**
 * Call one tool on a stdio MCP server.
 *
 * @param {object} opts
 *   @param {string} opts.cwd            working dir for the server (the agent root)
 *   @param {object} opts.serverConfig   { command, args, env? } (from .mcp.json)
 *   @param {string} opts.tool           tool name
 *   @param {object} opts.args           tool arguments
 *   @param {object} [opts.env]          base env (merged under serverConfig.env)
 *   @param {number} [opts.timeoutMs]
 * @returns {Promise<{ ok: boolean, text: string, raw?: object, error?: string }>}
 */
export async function callMcpTool({ cwd, serverConfig, tool, args, env, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const command = serverConfig?.command;
  if (typeof command !== 'string' || !command) {
    return { ok: false, text: '', error: 'tool server has no command' };
  }
  const serverArgs = Array.isArray(serverConfig.args) ? serverConfig.args : [];
  // Always inherit the real process env (PATH etc.) as the base; the caller's
  // env and the server's own env layer on top.
  const childEnv = { ...process.env, ...(env || {}), ...(serverConfig.env || {}) };

  const child = spawn(command, serverArgs, { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.setEncoding('utf8');

  let buffer = '';
  const pending = new Map(); // id → { resolve, reject }
  let fatal = null;

  const onLine = (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    p.resolve(msg);
  };

  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    if (buffer.length > MAX_LINE_CHARS && buffer.indexOf('\n') === -1) { buffer = ''; return; }
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) onLine(line);
    }
  });
  let stderrTail = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { stderrTail = `${stderrTail}${c}`.slice(-2000); });
  child.on('error', (e) => { fatal = e; for (const p of pending.values()) p.reject(e); pending.clear(); });
  child.on('close', () => { for (const p of pending.values()) p.reject(new Error('MCP server exited')); pending.clear(); });

  let nextId = 1;
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      if (fatal) { reject(fatal); return; }
      const id = nextId++;
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`MCP "${method}" timed out`));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve: (m) => { clearTimeout(timer); resolve(m); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (err) => {
        if (err && pending.delete(id)) { clearTimeout(timer); reject(err); }
      });
    });

  const close = async () => {
    try { if (!child.killed) child.stdin.end(); } catch { /* ignore */ }
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        try { if (child.pid) process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ }
        resolve();
      }, CLOSE_GRACE_MS);
      t.unref?.();
      child.once('close', () => { clearTimeout(t); resolve(); });
    });
  };

  try {
    await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'agent-mesh-fastpath', version: '0.1.0' } });
    const resp = await request('tools/call', { name: tool, arguments: args || {} });
    if (resp.error) return { ok: false, text: '', error: resp.error.message || 'tool error' };
    const content = Array.isArray(resp.result?.content) ? resp.result.content : [];
    const text = content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n');
    return { ok: true, text, raw: resp.result };
  } catch (err) {
    const detail = stderrTail.trim() ? `: ${stderrTail.trim()}` : '';
    return { ok: false, text: '', error: `${err.message}${detail}` };
  } finally {
    await close();
  }
}
