/**
 * test/dashboard-server.test.js
 *
 * Integration tests for src/dashboard/server.js.
 * All tests use ephemeral ports and tmp dirs; hermetic.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp, writeFile, mkdir, rm
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';

import { createDashboardServer } from '../src/dashboard/server.js';
import { initMesh } from '../src/builder/init-mesh.js';
import { writeManifest } from '../src/builder/manifest.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal mesh with two agents for testing.
 * Returns { meshRoot, agentARoot, agentBRoot }.
 */
async function buildTestMesh() {
  const meshRoot = await mkdtemp(join(tmpdir(), 'dash-srv-'));
  await initMesh(meshRoot);

  // Agent A
  const agentARoot = join(meshRoot, 'agent-a');
  await mkdir(join(agentARoot, 'prompts'), { recursive: true });
  await writeFile(
    join(agentARoot, 'agent.json'),
    JSON.stringify({
      name: 'agent-a',
      protocolVersion: '1.0',
      version: '0.1.0',
      skills: [],
      'x-agentmesh': { modes: ['ask'], meshVersion: '0.1.0' }
    }, null, 2),
    'utf8'
  );
  await writeFile(join(agentARoot, 'prompts', 'system.md'), '# Agent A\nYou are agent-a.', 'utf8');
  await mkdir(join(agentARoot, 'skills', 'local-review'), { recursive: true });
  await writeFile(
    join(agentARoot, 'skills', 'local-review', 'SKILL.md'),
    [
      '---',
      'name: local-review',
      'description: Review local agent output.',
      '---',
      '',
      '# local-review'
    ].join('\n'),
    'utf8'
  );
  await writeFile(
    join(agentARoot, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        'local-tool': {
          command: 'node',
          args: ['tools/local/server.mjs'],
          'x-agentmesh': { readOnly: true }
        }
      }
    }, null, 2),
    'utf8'
  );

  // Agent B
  const agentBRoot = join(meshRoot, 'agent-b');
  await mkdir(join(agentBRoot, 'prompts'), { recursive: true });
  await writeFile(
    join(agentBRoot, 'agent.json'),
    JSON.stringify({
      name: 'agent-b',
      protocolVersion: '1.0',
      version: '0.1.0',
      skills: [],
      'x-agentmesh': { modes: ['ask'], meshVersion: '0.1.0' }
    }, null, 2),
    'utf8'
  );
  await writeFile(join(agentBRoot, 'prompts', 'system.md'), '# Agent B\nYou are agent-b.', 'utf8');

  // Write manifest with agent-a → agent-b edge (served:true required for live edge)
  await writeManifest(meshRoot, {
    meshVersion: '0.1.0',
    agents: [
      {
        name: 'agent-a',
        root: './agent-a',
        card: 'agent.json',
        served: true,
        enabledModes: ['ask'],
        peers: []  // no peers to avoid manifest validation issue
      },
      {
        name: 'agent-b',
        root: './agent-b',
        card: 'agent.json',
        served: true,
        enabledModes: ['ask'],
        peers: []
      }
    ]
  });

  return { meshRoot, agentARoot, agentBRoot };
}

/**
 * Convenience: fetch from the test server with optional headers.
 */
async function fetchFrom(url, { headers = {}, method = 'GET' } = {}) {
  return fetch(url, {
    method,
    headers: {
      'Host': new URL(url).host,
      'Sec-Fetch-Site': 'same-origin',
      ...headers
    },
    redirect: 'manual'  // don't follow redirects automatically
  });
}

/**
 * Low-level HTTP request that allows overriding the Host header.
 * The fetch() API in Node.js ignores custom Host headers, so this uses
 * the raw http.request for tests that need to simulate wrong-host attacks.
 *
 * @returns {Promise<{ status: number, headers: object, body: string }>}
 */
function rawRequest({ port, path = '/', method = 'GET', headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body: data });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Start a server and get a valid cookie for authenticated requests.
 * Returns { srv, cookie, baseUrl, port }.
 */
async function startAuthedServer(meshRoot) {
  const srv = createDashboardServer({ meshRoot, port: 0 });
  await srv.start();
  const baseUrl = srv.url;
  const token = srv.token;
  const port = new URL(baseUrl).port;

  // Fetch bootstrap URL to get cookie
  const bootstrapRes = await fetch(`${baseUrl}/?t=${token}`, {
    headers: {
      'Host': `127.0.0.1:${port}`,
      'Sec-Fetch-Site': 'none'
    },
    redirect: 'manual'
  });
  // Should be 302
  const setCookie = bootstrapRes.headers.get('set-cookie') ?? '';
  // Extract cookie value
  const match = setCookie.match(/am_dash=([^;]+)/);
  assert.ok(match, `Expected am_dash cookie in Set-Cookie, got: ${setCookie}`);
  const cookie = `am_dash=${match[1]}`;

  return { srv, cookie, baseUrl, port };
}

// ---------------------------------------------------------------------------
// Bootstrap + auth
// ---------------------------------------------------------------------------

test('GET /?t=<token> → sets cookie + 302 redirect to /', async () => {
  const { meshRoot } = await buildTestMesh();
  const srv = createDashboardServer({ meshRoot, port: 0 });
  try {
    await srv.start();
    const token = srv.token;
    const port = new URL(srv.url).port;

    const res = await fetch(`${srv.url}/?t=${token}`, {
      headers: {
        'Host': `127.0.0.1:${port}`,
        'Sec-Fetch-Site': 'none'
      },
      redirect: 'manual'
    });

    assert.equal(res.status, 302, `Expected 302, got ${res.status}`);
    assert.equal(res.headers.get('location'), '/');

    const setCookie = res.headers.get('set-cookie') ?? '';
    assert.ok(setCookie.includes('am_dash='), 'Must set am_dash cookie');
    // SameSite=Lax (was Strict): Strict cookies set on a redirect are dropped by
    // some mobile browsers (iOS Safari); Lax is sent on top-level nav + same-site
    // subresources, which is exactly this same-origin dashboard. CSRF surface is
    // unchanged — the API also requires the token, never an ambient cross-site POST.
    assert.ok(setCookie.toLowerCase().includes('samesite=lax'), 'Must be SameSite=Lax');
    assert.ok(setCookie.toLowerCase().includes('httponly'), 'Must be HttpOnly');
  } finally {
    await srv.close();
  }
});

test('GET /?t=wrong-token → 403', async () => {
  const { meshRoot } = await buildTestMesh();
  const srv = createDashboardServer({ meshRoot, port: 0 });
  try {
    await srv.start();
    const port = new URL(srv.url).port;
    const res = await fetch(`${srv.url}/?t=wrong`, {
      headers: { 'Host': `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'none' },
      redirect: 'manual'
    });
    assert.equal(res.status, 403);
  } finally {
    await srv.close();
  }
});

test('request without cookie → 403', async () => {
  const { meshRoot } = await buildTestMesh();
  const srv = createDashboardServer({ meshRoot, port: 0 });
  try {
    await srv.start();
    const port = new URL(srv.url).port;
    const res = await fetch(`${srv.url}/api/mesh`, {
      headers: {
        'Host': `127.0.0.1:${port}`,
        'Sec-Fetch-Site': 'same-origin'
      }
    });
    assert.equal(res.status, 403);
  } finally {
    await srv.close();
  }
});

test('cross-origin request (Origin mismatch) → 403', async () => {
  const { meshRoot } = await buildTestMesh();
  const { srv, cookie, port } = await startAuthedServer(meshRoot);
  try {
    // Send request with Origin from different port
    const res = await fetch(`${srv.url}/api/mesh`, {
      headers: {
        'Host': `127.0.0.1:${port}`,
        'Origin': `http://localhost:9999`,
        'Sec-Fetch-Site': 'cross-site',
        'Cookie': cookie
      }
    });
    assert.equal(res.status, 403);
  } finally {
    await srv.close();
  }
});

test('wrong Host header → 403', async () => {
  const { meshRoot } = await buildTestMesh();
  const { srv, cookie, port } = await startAuthedServer(meshRoot);
  try {
    // Use raw http.request to actually send a forged Host header
    // (fetch() ignores custom Host headers)
    const res = await rawRequest({
      port,
      path: '/api/mesh',
      headers: {
        'Host': 'evil.com',  // wrong host — must be rejected
        'Sec-Fetch-Site': 'same-origin',
        'Cookie': cookie
      }
    });
    assert.equal(res.status, 403);
  } finally {
    await srv.close();
  }
});

test('wrong port in Host → 403', async () => {
  const { meshRoot } = await buildTestMesh();
  const { srv, cookie, port } = await startAuthedServer(meshRoot);
  try {
    // Use raw http.request to actually send a forged Host header
    const res = await rawRequest({
      port,
      path: '/api/mesh',
      headers: {
        'Host': `127.0.0.1:9999`,  // wrong port — must be rejected
        'Sec-Fetch-Site': 'same-origin',
        'Cookie': cookie
      }
    });
    assert.equal(res.status, 403);
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------

test('responses include X-Content-Type-Options + Referrer-Policy + CSP', async () => {
  const { meshRoot } = await buildTestMesh();
  const { srv, cookie, port } = await startAuthedServer(meshRoot);
  try {
    const res = await fetch(`${srv.url}/api/mesh`, {
      headers: {
        'Host': `127.0.0.1:${port}`,
        'Sec-Fetch-Site': 'same-origin',
        'Cookie': cookie
      }
    });
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.ok(csp.includes("default-src 'self'"), `CSP must include default-src 'self', got: ${csp}`);
    assert.ok(csp.includes("img-src 'self'"), `CSP must include img-src 'self', got: ${csp}`);
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
// /api/mesh
// ---------------------------------------------------------------------------

test('/api/mesh returns agents + graph shape', async () => {
  const { meshRoot } = await buildTestMesh();
  const { srv, cookie, port } = await startAuthedServer(meshRoot);
  try {
    const res = await fetch(`${srv.url}/api/mesh`, {
      headers: {
        'Host': `127.0.0.1:${port}`,
        'Sec-Fetch-Site': 'same-origin',
        'Cookie': cookie
      }
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.agents), 'agents must be array');
    assert.ok(body.graph, 'graph must be present');
    assert.ok(Array.isArray(body.graph.nodes), 'graph.nodes must be array');
    assert.ok(Array.isArray(body.graph.edges), 'graph.edges must be array');
    // Should have agent-a and agent-b
    const names = body.agents.map(a => a.name);
    assert.ok(names.includes('agent-a'));
    assert.ok(names.includes('agent-b'));
  } finally {
    await srv.close();
  }
});

test('/api/resources returns grouped mesh and per-agent resources', async () => {
  const { meshRoot } = await buildTestMesh();
  const { srv, cookie, port } = await startAuthedServer(meshRoot);
  try {
    const res = await fetch(`${srv.url}/api/resources`, {
      headers: {
        'Host': `127.0.0.1:${port}`,
        'Sec-Fetch-Site': 'same-origin',
        'Cookie': cookie
      }
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.totals, { skills: 2, mcps: 1 });

    const mesh = body.groups.find(g => g.id === 'mesh');
    assert.ok(mesh);
    assert.equal(mesh.counts.skills, 1);
    assert.equal(mesh.skills[0].source, 'mesh');

    const agentA = body.groups.find(g => g.id === 'agent-a');
    assert.ok(agentA);
    assert.deepEqual(agentA.counts, { skills: 1, mcps: 1 });
    assert.equal(agentA.skills[0].name, 'local-review');
    assert.equal(agentA.mcps[0].grant, 'readOnly');
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
// /api/agent/:name
// ---------------------------------------------------------------------------

test('/api/agent/:name returns structure + card', async () => {
  const { meshRoot } = await buildTestMesh();
  const { srv, cookie, port } = await startAuthedServer(meshRoot);
  try {
    const res = await fetch(`${srv.url}/api/agent/agent-a`, {
      headers: {
        'Host': `127.0.0.1:${port}`,
        'Sec-Fetch-Site': 'same-origin',
        'Cookie': cookie
      }
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.name, 'agent-a');
    assert.ok(body.card, 'card must be present');
    assert.ok(body.structure, 'structure must be present');
  } finally {
    await srv.close();
  }
});

test('/api/agent/:name → 404 for unknown agent', async () => {
  const { meshRoot } = await buildTestMesh();
  const { srv, cookie, port } = await startAuthedServer(meshRoot);
  try {
    const res = await fetch(`${srv.url}/api/agent/does-not-exist`, {
      headers: {
        'Host': `127.0.0.1:${port}`,
        'Sec-Fetch-Site': 'same-origin',
        'Cookie': cookie
      }
    });
    assert.equal(res.status, 404);
  } finally {
    await srv.close();
  }
});

test('/api/agent/:name → 403 when agent root escapes mesh', async () => {
  const meshRoot = await mkdtemp(join(tmpdir(), 'dash-escape-'));
  await initMesh(meshRoot);

  // Write a manifest with a root that escapes the mesh
  await writeManifest(meshRoot, {
    meshVersion: '0.1.0',
    agents: [
      {
        name: 'escape-agent',
        root: '../escape-agent',  // This escapes the mesh
        card: 'agent.json',
        served: true,
        enabledModes: ['ask'],
        peers: []
      }
    ]
  });

  const { srv, cookie, port } = await startAuthedServer(meshRoot);
  try {
    const res = await fetch(`${srv.url}/api/agent/escape-agent`, {
      headers: {
        'Host': `127.0.0.1:${port}`,
        'Sec-Fetch-Site': 'same-origin',
        'Cookie': cookie
      }
    });
    // Should be denied (403) because root escapes mesh boundary
    assert.ok(
      res.status === 403 || res.status === 404,
      `Expected 403 or 404, got ${res.status}`
    );
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
// /api/tree
// ---------------------------------------------------------------------------

test('/api/tree omits sensitive files', async () => {
  const { meshRoot } = await buildTestMesh();
  // Add a sensitive file
  await writeFile(join(meshRoot, '.env'), 'SECRET=hidden', 'utf8');

  const { srv, cookie, port } = await startAuthedServer(meshRoot);
  try {
    const res = await fetch(`${srv.url}/api/tree?scope=mesh`, {
      headers: {
        'Host': `127.0.0.1:${port}`,
        'Sec-Fetch-Site': 'same-origin',
        'Cookie': cookie
      }
    });
    assert.equal(res.status, 200);
    const tree = await res.json();
    assert.ok(Array.isArray(tree), 'tree must be array');
    const paths = tree.map(e => e.path);
    assert.ok(!paths.includes('.env'), '.env must not appear in tree');
    assert.ok(!paths.some(p => p.includes('.env')), '.env must not appear anywhere');
  } finally {
    await srv.close();
  }
});

test('/api/tree returns mesh.json for mesh scope', async () => {
  const { meshRoot } = await buildTestMesh();
  const { srv, cookie, port } = await startAuthedServer(meshRoot);
  try {
    const res = await fetch(`${srv.url}/api/tree?scope=mesh`, {
      headers: {
        'Host': `127.0.0.1:${port}`,
        'Sec-Fetch-Site': 'same-origin',
        'Cookie': cookie
      }
    });
    const tree = await res.json();
    const paths = tree.map(e => e.path);
    assert.ok(paths.includes('mesh.json'), 'mesh.json must be in tree');
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
// /api/file
// ---------------------------------------------------------------------------

test('/api/file serves an in-root non-sensitive file', async () => {
  const { meshRoot } = await buildTestMesh();
  const { srv, cookie, port } = await startAuthedServer(meshRoot);
  try {
    const filePath = join(meshRoot, 'mesh.json');
    const res = await fetch(`${srv.url}/api/file?path=${encodeURIComponent(filePath)}`, {
      headers: {
        'Host': `127.0.0.1:${port}`,
        'Sec-Fetch-Site': 'same-origin',
        'Cookie': cookie
      }
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.kind, 'text');
    assert.ok(body.content.includes('meshVersion'), 'content must be mesh.json');
  } finally {
    await srv.close();
  }
});

test('/api/file → 403 for out-of-root path', async () => {
  const { meshRoot } = await buildTestMesh();
  const { srv, cookie, port } = await startAuthedServer(meshRoot);
  try {
    const outsidePath = '/etc/passwd';
    const res = await fetch(`${srv.url}/api/file?path=${encodeURIComponent(outsidePath)}`, {
      headers: {
        'Host': `127.0.0.1:${port}`,
        'Sec-Fetch-Site': 'same-origin',
        'Cookie': cookie
      }
    });
    assert.equal(res.status, 403);
  } finally {
    await srv.close();
  }
});

test('/api/file → 403 for .env file inside root', async () => {
  const { meshRoot } = await buildTestMesh();
  await writeFile(join(meshRoot, '.env'), 'SECRET=hidden', 'utf8');

  const { srv, cookie, port } = await startAuthedServer(meshRoot);
  try {
    const envPath = join(meshRoot, '.env');
    const res = await fetch(`${srv.url}/api/file?path=${encodeURIComponent(envPath)}`, {
      headers: {
        'Host': `127.0.0.1:${port}`,
        'Sec-Fetch-Site': 'same-origin',
        'Cookie': cookie
      }
    });
    assert.equal(res.status, 403);
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
// /api/skills + /api/mcps
// ---------------------------------------------------------------------------

test('/api/skills returns array', async () => {
  const { meshRoot } = await buildTestMesh();
  const { srv, cookie, port } = await startAuthedServer(meshRoot);
  try {
    const res = await fetch(`${srv.url}/api/skills`, {
      headers: {
        'Host': `127.0.0.1:${port}`,
        'Sec-Fetch-Site': 'same-origin',
        'Cookie': cookie
      }
    });
    assert.equal(res.status, 200);
    const skills = await res.json();
    assert.ok(Array.isArray(skills), 'skills must be array');
    // The mesh has citation-format seed skill
    const global = skills.find(s => s.source === 'mesh');
    assert.ok(global, 'global mesh skill must be present');
  } finally {
    await srv.close();
  }
});

test('/api/mcps returns array', async () => {
  const { meshRoot } = await buildTestMesh();
  const { srv, cookie, port } = await startAuthedServer(meshRoot);
  try {
    const res = await fetch(`${srv.url}/api/mcps`, {
      headers: {
        'Host': `127.0.0.1:${port}`,
        'Sec-Fetch-Site': 'same-origin',
        'Cookie': cookie
      }
    });
    assert.equal(res.status, 200);
    const mcps = await res.json();
    assert.ok(Array.isArray(mcps), 'mcps must be array');
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
// createDashboardServer: start/close lifecycle
// ---------------------------------------------------------------------------

test('server closes cleanly', async () => {
  const { meshRoot } = await buildTestMesh();
  const srv = createDashboardServer({ meshRoot, port: 0 });
  await srv.start();
  assert.ok(srv.url.startsWith('http://127.0.0.1:'));
  await srv.close();
  // After close, requests should fail
  await assert.rejects(
    () => fetch(srv.url + '/api/mesh'),
    'Fetch should fail after server close'
  );
});

test('server binds to 127.0.0.1 only', async () => {
  const { meshRoot } = await buildTestMesh();
  const srv = createDashboardServer({ meshRoot, port: 0 });
  await srv.start();
  try {
    assert.ok(srv.url.includes('127.0.0.1'), `URL must be 127.0.0.1, got: ${srv.url}`);
    assert.ok(!srv.url.includes('0.0.0.0'), 'URL must not be 0.0.0.0');
  } finally {
    await srv.close();
  }
});

test('bootstrapUrl contains token', async () => {
  const { meshRoot } = await buildTestMesh();
  const srv = createDashboardServer({ meshRoot, port: 0 });
  await srv.start();
  try {
    assert.ok(srv.bootstrapUrl.includes(`/?t=${srv.token}`));
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
// Static asset serving (Inc 1b)
// ---------------------------------------------------------------------------

test('GET / returns the board (board2.html, 200, text/html) behind auth cookie', async () => {
  const { meshRoot } = await buildTestMesh();
  const { srv, cookie, port } = await startAuthedServer(meshRoot);
  try {
    const res = await fetchFrom(`${srv.url}/`, {
      headers: {
        'Host': `127.0.0.1:${port}`,
        'Sec-Fetch-Site': 'same-origin',
        'Cookie': cookie
      }
    });
    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
    const ct = res.headers.get('content-type') ?? '';
    assert.ok(ct.includes('text/html'), `Expected text/html content-type, got: ${ct}`);
    const body = await res.text();
    assert.ok(body.includes('agent_mesh'), 'the board page must mention agent_mesh');
    assert.ok(body.includes('<html'), 'the board page must be HTML');
  } finally {
    await srv.close();
  }
});

test('GET /board2.js returns JavaScript (200, application/javascript) behind auth cookie', async () => {
  const { meshRoot } = await buildTestMesh();
  const { srv, cookie, port } = await startAuthedServer(meshRoot);
  try {
    const res = await fetchFrom(`${srv.url}/board2.js`, {
      headers: {
        'Host': `127.0.0.1:${port}`,
        'Sec-Fetch-Site': 'same-origin',
        'Cookie': cookie
      }
    });
    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
    const ct = res.headers.get('content-type') ?? '';
    assert.ok(ct.includes('javascript'), `Expected javascript content-type, got: ${ct}`);
  } finally {
    await srv.close();
  }
});

test('GET /board2.css returns CSS (200) behind auth cookie', async () => {
  const { meshRoot } = await buildTestMesh();
  const { srv, cookie, port } = await startAuthedServer(meshRoot);
  try {
    const res = await fetchFrom(`${srv.url}/board2.css`, {
      headers: {
        'Host': `127.0.0.1:${port}`,
        'Sec-Fetch-Site': 'same-origin',
        'Cookie': cookie
      }
    });
    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
    const ct = res.headers.get('content-type') ?? '';
    assert.ok(ct.includes('css') || ct.includes('text'), `Expected CSS content-type, got: ${ct}`);
  } finally {
    await srv.close();
  }
});

test('GET /board2.js without cookie → 403', async () => {
  const { meshRoot } = await buildTestMesh();
  const { srv, port } = await startAuthedServer(meshRoot);
  try {
    const res = await fetchFrom(`${srv.url}/board2.js`, {
      headers: {
        'Host': `127.0.0.1:${port}`,
        'Sec-Fetch-Site': 'same-origin'
        // No Cookie header
      }
    });
    assert.equal(res.status, 403, `Expected 403 without cookie, got ${res.status}`);
  } finally {
    await srv.close();
  }
});

test('GET / without cookie → 403', async () => {
  const { meshRoot } = await buildTestMesh();
  const { srv, port } = await startAuthedServer(meshRoot);
  try {
    const res = await fetchFrom(`${srv.url}/`, {
      headers: {
        'Host': `127.0.0.1:${port}`,
        'Sec-Fetch-Site': 'same-origin'
        // No Cookie
      }
    });
    assert.equal(res.status, 403, `Expected 403 without cookie, got ${res.status}`);
  } finally {
    await srv.close();
  }
});

test('static asset with path traversal attempt → 403 or 404', async () => {
  const { meshRoot } = await buildTestMesh();
  const { srv, cookie, port } = await startAuthedServer(meshRoot);
  try {
    // Traversal: GET /../../../etc/passwd
    const res = await rawRequest({
      port,
      path: '/%2e%2e%2f%2e%2e%2fetc/passwd',
      headers: {
        'Host': `127.0.0.1:${port}`,
        'Sec-Fetch-Site': 'same-origin',
        'Cookie': cookie
      }
    });
    assert.ok(
      res.status === 403 || res.status === 404,
      `Expected 403 or 404 for traversal attempt, got ${res.status}`
    );
  } finally {
    await srv.close();
  }
});

test('static assets still have security headers (CSP, nosniff)', async () => {
  const { meshRoot } = await buildTestMesh();
  const { srv, cookie, port } = await startAuthedServer(meshRoot);
  try {
    const res = await fetchFrom(`${srv.url}/`, {
      headers: {
        'Host': `127.0.0.1:${port}`,
        'Sec-Fetch-Site': 'same-origin',
        'Cookie': cookie
      }
    });
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.ok(csp.includes("default-src 'self'"), `CSP missing on static asset: ${csp}`);
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
// auto-sync: injectable runSync; startup run; opt-out via AGENT_MESH_NO_AUTOSYNC
// ---------------------------------------------------------------------------

test('auto-sync: startup runs the managed sync once; opt-out env suppresses it', async (t) => {
  const { meshRoot } = await buildTestMesh();

  // ENABLED: startup runNow should fire once. Deterministic — the test awaits a
  // signal the injected runSync resolves, not a wall-clock sleep (slow Windows CI
  // runners can stall past a fixed timeout; absence of a sleep removes that flake).
  const calls = [];
  let fired; const ran = new Promise((r) => { fired = r; });
  const srv = createDashboardServer({
    meshRoot,
    port: 0,
    token: 'tok',
    runSync: async () => { calls.push(1); fired(); return { fixed: [] }; }
  });
  await srv.start();
  await ran; // resolves when startup runNow invoked runSync
  assert.equal(calls.length, 1, `Expected 1 startup sync call, got ${calls.length}`);
  await srv.close();

  // OPT-OUT: AGENT_MESH_NO_AUTOSYNC=1 → zero calls.
  const prev = process.env.AGENT_MESH_NO_AUTOSYNC;
  process.env.AGENT_MESH_NO_AUTOSYNC = '1';
  try {
    const calls2 = [];
    const srv2 = createDashboardServer({
      meshRoot,
      port: 0,
      token: 'tok',
      runSync: async () => { calls2.push(1); return { fixed: [] }; }
    });
    await srv2.start();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(calls2.length, 0, `Expected 0 sync calls with opt-out, got ${calls2.length}`);
    await srv2.close();
  } finally {
    if (prev === undefined) delete process.env.AGENT_MESH_NO_AUTOSYNC;
    else process.env.AGENT_MESH_NO_AUTOSYNC = prev;
  }
});
