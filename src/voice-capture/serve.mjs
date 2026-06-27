// Standalone launcher for the Mac /capture endpoint (tailnet-only).
// Env: CAPTURE_PORT (8787), MAC_CAPTURE_TOKEN (required), CAPTURE_DIR (.captures).
// Bind 127.0.0.1; expose via Tailscale (allowed-host + token), never public.
import { createCaptureServer } from './server.js';

const port = Number(process.env.CAPTURE_PORT || 8787);
const token = process.env.MAC_CAPTURE_TOKEN || '';
const dir = process.env.CAPTURE_DIR || '.captures';
if (!token) {
  console.error('MAC_CAPTURE_TOKEN is required');
  process.exit(2);
}
const srv = createCaptureServer({ token, dir });
srv.listen(port, '127.0.0.1', () => console.log(`capture listening 127.0.0.1:${port} dir=${dir}`));
