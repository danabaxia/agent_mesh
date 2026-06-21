// test/e2e/fixture-server.mjs — PROVABLY-SYNTHETIC dashboard fixture server for
// the Playwright e2e/visual tier (Plan 3). NIGHTLY-ONLY.
//
// This is NOT the real dashboard server (src/dashboard/server.js). It serves the
// real static front-end assets from src/dashboard/public/ UNCHANGED, but answers
// every /api/* call with a fixed, hand-authored synthetic payload (see FIXTURES
// below) — no mesh root, no git, no scheduler, no sessions, no Claude. Every value
// is obviously fake (agents "alpha"/"beta"/"gamma", repo "synthetic/fixture").
// That makes the rendered page deterministic and side-effect-free: the e2e tier
// exercises the SHIPPED render code against KNOWN data, which is exactly what a
// visual-regression baseline needs.
//
// Determinism: the payloads are static; the front-end seeds Math.random and
// settles the net-graph synchronously under ?e2e=1 (src/dashboard/public/
// e2e-mode.js), and the page stamps <body data-render-state="settled"> when the
// initial render completes. The spec waits on that attribute — no sleeps.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'dashboard', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// ── synthetic API payloads — every value is obviously fake ──────────────────
const AGENTS = [
  { name: 'alpha', served: true, modes: ['ask', 'do'], description: 'synthetic agent alpha', peers: ['beta', 'gamma'] },
  { name: 'beta', served: true, modes: ['ask'], description: 'synthetic agent beta', peers: ['alpha'] },
  { name: 'gamma', served: false, modes: ['ask', 'do'], description: 'synthetic agent gamma', peers: ['alpha'] },
];

const FIXTURES = {
  '/api/mesh': { meshRoot: '/synthetic/fixture', agents: AGENTS },
  '/api/resources': {
    totals: { skills: 6, mcps: 3 },
    groups: [
      { id: 'mesh', counts: { skills: 0, mcps: 1 }, mcps: [{ name: 'mesh-health', config: { 'x-agentmesh': { readOnly: true } } }] },
      { id: 'alpha', counts: { skills: 3, mcps: 1 }, skills: [{ name: 's1' }], mcps: [{ name: 'local-a' }] },
      { id: 'beta', counts: { skills: 2, mcps: 0 }, skills: [{ name: 's2' }], mcps: [] },
      { id: 'gamma', counts: { skills: 1, mcps: 1 }, skills: [{ name: 's3' }], mcps: [{ name: 'local-c' }] },
    ],
  },
  '/api/activity': {
    agents: [
      { name: 'alpha', state: 'working', route: 'beta/ask', since: '2026-06-20T00:00:00Z' },
      { name: 'beta', state: 'live' },
      { name: 'gamma', state: 'idle' },
    ],
    edges: [
      { from: 'alpha', to: 'beta', active: true },
      { from: 'alpha', to: 'gamma', active: false },
    ],
    events: [
      { kind: 'a2a', at: '2026-06-20T00:00:00Z', from: 'alpha', to: 'beta' },
      { kind: 'session', at: '2026-06-20T00:01:00Z', agent: 'beta' },
    ],
  },
  '/api/collab': {
    agents: [
      { name: 'alpha', color: '#3b82f6', volume: 9 },
      { name: 'beta', color: '#10b981', volume: 4 },
      { name: 'gamma', color: '#f59e0b', volume: 1 },
    ],
    links: [{ a: 'alpha', b: 'beta', w: 3, active: true }, { a: 'alpha', b: 'gamma', w: 1, active: false }],
  },
  '/api/usage': { series: [{ value: 100 }, { value: 250 }, { value: 50 }] },
  '/api/schedules': {
    jobs: [
      { id: 'merge-sweep', description: 'sweep stale PRs', lastSummary: 'flagged 1, clean 2', lastStatus: 'ok', lastRunAt: '2026-06-20T00:00:00Z' },
      { id: 'tester-suite-run', description: 'nightly suite', lastSummary: 'suite green', lastStatus: 'ok', lastRunAt: '2026-06-20T00:05:00Z' },
    ],
  },
  '/api/issues': { openNow: 7 },
};

function sendJson(res, body) {
  const s = JSON.stringify(body);
  res.writeHead(200, { 'content-type': MIME['.json'], 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

async function sendFile(res, filePath) {
  try {
    const buf = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404).end('not found');
  }
}

export function createFixtureServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const path = url.pathname;

    // SSE endpoint: open and idle (no events) — the board falls back to its
    // initial render, which is what we want for a stable snapshot.
    if (path === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': synthetic e2e stream — idle\n\n');
      return; // keep open; closed when the server closes
    }

    if (path.startsWith('/api/')) {
      const fixture = FIXTURES[path];
      if (fixture) return sendJson(res, fixture);
      // Unknown api: empty object (best-effort endpoints tolerate this).
      return sendJson(res, {});
    }

    // static assets from public/ — default to board2.html
    const rel = path === '/' ? '/board2.html' : path;
    const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '');
    return sendFile(res, join(PUBLIC_DIR, safe));
  });
}

// Standalone entry: `node test/e2e/fixture-server.mjs [port]` (used by the
// Playwright webServer config). Listens on 127.0.0.1 and logs the URL.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.argv[2] || process.env.E2E_PORT || 7099);
  createFixtureServer().listen(port, '127.0.0.1', () => {
    process.stdout.write(`fixture-server listening on http://127.0.0.1:${port}\n`);
  });
}
