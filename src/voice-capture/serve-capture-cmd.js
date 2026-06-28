// `agent-mesh serve-capture <dir>` factory: build the tailnet-only Mac /capture
// server from args + env, WITHOUT the blocking listen loop (so it's unit-testable).
// The CLI branch calls this, then listens + waits for SIGINT. ESM.
import { createCaptureServer } from './server.js';

export function buildCaptureServer(args, env = process.env) {
  const token = env.MAC_CAPTURE_TOKEN || '';
  if (!token) throw new Error('MAC_CAPTURE_TOKEN is required for serve-capture');
  const dir = args[0] || env.CAPTURE_DIR || '.captures';
  const port = Number(env.CAPTURE_PORT || 8787);
  const host = '127.0.0.1';                       // tailnet-only; expose via Tailscale, never public
  const server = createCaptureServer({ token, dir });
  return { server, port, host, dir };
}
