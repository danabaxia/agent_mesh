// `agent-mesh serve-capture <dir>` factory: build the tailnet-only Mac /capture
// server from args + env, WITHOUT the blocking listen loop (so it's unit-testable).
// The CLI branch calls this, then listens + waits for SIGINT. ESM.
import { join } from 'node:path';
import { createCaptureServer } from './server.js';

export function buildCaptureServer(args, env = process.env) {
  const token = env.MAC_CAPTURE_TOKEN || '';
  if (!token) throw new Error('MAC_CAPTURE_TOKEN is required for serve-capture');
  const dir = args[0] || env.CAPTURE_DIR || '.captures';
  const port = Number(env.CAPTURE_PORT || 8787);
  // Default loopback-only (plan: expose via Tailscale). CAPTURE_HOST widens the bind
  // (e.g. 0.0.0.0) for direct LAN/tailnet sync from the voice box — still bearer-gated.
  const host = env.CAPTURE_HOST || '127.0.0.1';
  const inspirationToken = env.MAC_INSPIRATION_TOKEN || '';
  const inspirationFile = env.AGENT_MESH_INSPIRATION_FILE
    || join(env.MESH_ROOT || dir, '.dev-society', 'inspiration.json');
  const server = createCaptureServer({ token, dir, inspirationToken, inspirationFile });
  return { server, port, host, dir };
}
