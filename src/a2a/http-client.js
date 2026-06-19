// HTTP header names for recursion env threading (stdio passes these via process.env;
// HTTP passes them as request headers so the server can enforce the same budget).
const RECURSION_HEADERS = {
  AGENT_MESH_PATH: 'X-AgentMesh-Path',
  AGENT_MESH_DEPTH: 'X-AgentMesh-Depth'
};

// Per-request timeout — sits above the server's own task timeout (default 600s)
// to handle genuine transport-level loss rather than slow tasks.
const DEFAULT_REQUEST_TIMEOUT_MS = 660_000;

// Stateless per-request HTTP session. One instance is reused across calls to the
// same peer (like StdioClientSession), but unlike stdio there is no persistent
// subprocess — each request() opens a fresh fetch.
export class HttpClientSession {
  constructor(peer, baseEnv, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    this.peer = peer;
    this.nextId = 1;
    this.baseEnv = baseEnv;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async request(method, params) {
    const id = this.nextId++;
    const headers = { 'Content-Type': 'application/json' };

    // Forward caller's recursion state as request headers so the HTTP server
    // enforces the same cycle/depth budget across the transport boundary.
    for (const [envKey, headerName] of Object.entries(RECURSION_HEADERS)) {
      const val = this.baseEnv[envKey];
      if (val !== undefined && val !== '') headers[headerName] = val;
    }

    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const controller = new AbortController();
    const timer = this.requestTimeoutMs
      ? setTimeout(() => controller.abort(), this.requestTimeoutMs)
      : null;
    let response;
    try {
      response = await fetch(this.peer.url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal
      });
    } catch (err) {
      throw new Error(
        `A2A HTTP request "${method}" to peer "${this.peer.name}" failed: ${err.message}`
      );
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!response.ok) {
      throw new Error(
        `A2A HTTP peer "${this.peer.name}" returned HTTP ${response.status}`
      );
    }

    let json;
    try {
      json = await response.json();
    } catch (err) {
      throw new Error(
        `A2A HTTP peer "${this.peer.name}" returned non-JSON: ${err.message}`
      );
    }
    if (json.error) throw new Error(json.error.message);
    return json;
  }

  // HTTP sessions are stateless — no persistent connection to clean up.
  async close() {}
}
