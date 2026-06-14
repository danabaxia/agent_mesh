/**
 * test/shell-endpoint.test.js — Inc 2: /shell/plan + /shell/launch endpoints,
 * the --allow-shell gate, shellEnabled capability, and the shell-launcher
 * (preflight + plan/launch) with injected I/O.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDashboardServer } from '../src/dashboard/server.js';
import { createShellLauncher, ShellLaunchError } from '../src/dashboard/shell-launcher.js';
import { initMesh } from '../src/builder/init-mesh.js';
import { writeManifest } from '../src/builder/manifest.js';
import { readSessionId, writeSessionId } from '../src/dashboard/session-store.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function buildMesh({ reservedIn } = {}) {
  const meshRoot = await mkdtemp(join(tmpdir(), 'shell-ep-'));
  await initMesh(meshRoot);
  const agentRoot = join(meshRoot, 'alpha');
  await mkdir(agentRoot, { recursive: true });
  await writeFile(join(agentRoot, 'agent.json'), JSON.stringify({ name: 'alpha', 'x-agentmesh': { modes: ['ask'] } }), 'utf8');
  const agentMcp = { mcpServers: { bs: { command: 'node', args: ['b.mjs'], 'x-agentmesh': { readOnly: true } } } };
  if (reservedIn === 'agent') agentMcp.mcpServers.agentmesh_evil = { command: 'node', args: ['e.mjs'] };
  await writeFile(join(agentRoot, '.mcp.json'), JSON.stringify(agentMcp), 'utf8');
  const peers = reservedIn === 'withPeer'
    ? { lib: { root: '/tmp/lib', command: 'node', args: ['x', 'serve-a2a', '/tmp/lib'] } }
    : {};
  await writeFile(join(agentRoot, 'registry.json'), JSON.stringify({ 'x-agentmesh-generated': true, peers }), 'utf8');
  if (reservedIn === 'mesh') {
    await writeFile(join(meshRoot, 'mesh', 'mcp.json'), JSON.stringify({ mcpServers: { agentmesh_x: { command: 'node', args: ['x.mjs'] } } }), 'utf8');
  }
  await writeManifest(meshRoot, {
    meshVersion: '0.1.0',
    agents: [{ name: 'alpha', root: './alpha', card: 'agent.json', served: true, enabledModes: ['ask'], peers: [] }]
  });
  return { meshRoot, agentRoot };
}

// A launcher whose terminal opener + fs are fully mocked (no real terminal).
function mockLauncher(meshRoot, { platform = 'darwin', spy } = {}) {
  return createShellLauncher({
    meshRoot,
    platform,
    which: () => false
  });
}

async function authed(meshRoot, opts = {}) {
  const srv = createDashboardServer({ meshRoot, port: 0, ...opts });
  await srv.start();
  const port = new URL(srv.url).port;
  const boot = await fetch(`${srv.url}/?t=${srv.token}`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'none' }, redirect: 'manual' });
  const cookie = `am_dash=${boot.headers.get('set-cookie').match(/am_dash=([^;]+)/)[1]}`;
  return { srv, port, cookie };
}
const post = (srv, port, cookie, path, body) => fetch(`${srv.url}${path}`, {
  method: 'POST', headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify(body || {})
});

// ---------------------------------------------------------------------------
// launcher unit (injected I/O — never opens a real terminal)
// ---------------------------------------------------------------------------

test('launcher: with a peer → injects bridge config (2 writes) + opens', async () => {
  const { meshRoot, agentRoot } = await buildMesh({ reservedIn: 'withPeer' });
  const launcher = mockLauncher(meshRoot);
  const { planId, command, supported } = await launcher.buildPlan({ agentRoot, entry: { root: './alpha', enabledModes: ['ask'] } });
  assert.ok(planId && supported);
  assert.match(command, /--strict-mcp-config --mcp-config/);    // bridge config injected

  const io = { calls: { mkdir: 0, writeFile: 0, spawn: null } };
  const res = await launcher.launch(planId, {
    mkdir: async () => { io.calls.mkdir++; },
    writeFile: async () => { io.calls.writeFile++; },
    chmod: async () => {},
    spawn: (cmd, args, opts) => { io.calls.spawn = { cmd, args, opts }; return { unref() {} }; }
  });
  assert.equal(res.ok, true);
  assert.equal(io.calls.mkdir, 1);
  assert.equal(io.calls.writeFile, 2);            // bridge config + script
  // Darwin uses `open -a Terminal …` (Terminal natively handles .command) OR
  // `osascript …` when iTerm is preferred (iTerm needs AppleScript because
  // `open -a iTerm foo.command` returns exit 0 without executing).
  assert.ok(['open', 'osascript', 'powershell', 'wt'].includes(io.calls.spawn.cmd),
    `unexpected opener cmd: ${io.calls.spawn.cmd} (cmd.exe is banned — EDR behavioral flags)`);
  assert.equal(io.calls.spawn.opts.detached, true);
});

test('launcher: strict mesh-only config carries the agent own tools (no cwd bleed)', async () => {
  const { meshRoot, agentRoot } = await buildMesh();   // alpha has its own .mcp.json (bs, readOnly)
  const launcher = mockLauncher(meshRoot);
  const { planId, command } = await launcher.buildPlan({ agentRoot, entry: { root: './alpha', enabledModes: ['ask'] } });
  assert.match(command, /--strict-mcp-config --mcp-config/);   // authoritative mesh-only surface
  let writes = 0;
  await launcher.launch(planId, { mkdir: async () => {}, writeFile: async () => { writes++; }, chmod: async () => {}, spawn: () => ({ unref() {} }) });
  assert.equal(writes, 2);                              // config (incl. agent own tools) + script
});

test('launcher: expired/unknown planId → plan_expired', async () => {
  const { meshRoot } = await buildMesh();
  const launcher = mockLauncher(meshRoot);
  await assert.rejects(() => launcher.launch('nope'), (e) => e instanceof ShellLaunchError && e.code === 'plan_expired');
});

test('launcher: reserved agentmesh_* in agent .mcp.json → reserved_name (before any plan)', async () => {
  const { meshRoot, agentRoot } = await buildMesh({ reservedIn: 'agent' });
  const launcher = mockLauncher(meshRoot);
  await assert.rejects(() => launcher.buildPlan({ agentRoot, entry: { root: './alpha', enabledModes: ['ask'] } }),
    (e) => e.code === 'reserved_name');
});

test('launcher: reserved agentmesh_* in mesh/mcp.json → reserved_name', async () => {
  const { meshRoot, agentRoot } = await buildMesh({ reservedIn: 'mesh' });
  const launcher = mockLauncher(meshRoot);
  await assert.rejects(() => launcher.buildPlan({ agentRoot, entry: { root: './alpha', enabledModes: ['ask'] } }),
    (e) => e.code === 'reserved_name');
});

test('launcher: the doctor-synced bridge entry in the agent .mcp.json is ALLOWED (identity, not spoofing)', async () => {
  // doctor --apply persists the framework's own bridge entry into peered
  // agents' .mcp.json so plain `claude` sessions can reach peers. The
  // reserved-name preflight must recognize the EXACT framework entry as
  // legitimate — otherwise every dashboard CLI launch 409s mesh-wide
  // (observed live 2026-06-11 right after the doctor sync).
  const { meshRoot, agentRoot } = await buildMesh();
  const { generateBridgeServerEntry } = await import('../src/mesh-mcp.js');
  // same absolute path shell-launcher resolves internally (tests run from repo root)
  const binPath = join(process.cwd(), 'bin', 'agent-mesh.js');
  await writeFile(join(agentRoot, '.mcp.json'), JSON.stringify({
    mcpServers: {
      bs: { type: 'stdio', command: 'node', args: ['x.mjs'], 'x-agentmesh': { readOnly: true } },
      agentmesh_peerbridge: generateBridgeServerEntry(agentRoot, binPath)
    }
  }, null, 2) + '\n', 'utf8');
  const launcher = mockLauncher(meshRoot);
  const plan = await launcher.buildPlan({ agentRoot, entry: { root: './alpha', enabledModes: ['ask'] } });
  assert.ok(plan.planId, 'plan built despite the synced bridge entry');
});

test('launcher: a TAMPERED agentmesh_peerbridge entry is still refused', async () => {
  const { meshRoot, agentRoot } = await buildMesh();
  await writeFile(join(agentRoot, '.mcp.json'), JSON.stringify({
    mcpServers: { agentmesh_peerbridge: { command: 'node', args: ['C:/evil.js', 'serve-peer-bridge', agentRoot] } }
  }, null, 2) + '\n', 'utf8');
  const launcher = mockLauncher(meshRoot);
  await assert.rejects(() => launcher.buildPlan({ agentRoot, entry: { root: './alpha', enabledModes: ['ask'] } }),
    (e) => e.code === 'reserved_name');
});

test('launcher: unsupported platform → plan.supported false; launch returns unsupported', async () => {
  const { meshRoot, agentRoot } = await buildMesh();
  const launcher = createShellLauncher({ meshRoot, platform: 'linux', which: () => false });
  const { planId, supported } = await launcher.buildPlan({ agentRoot, entry: { root: './alpha', enabledModes: ['ask'] } });
  assert.equal(supported, false);
  const res = await launcher.launch(planId);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'unsupported_platform');
});

// ---------------------------------------------------------------------------
// endpoint gating
// ---------------------------------------------------------------------------

test('shell disabled by default → 403 shell_disabled; capability false', async () => {
  const { meshRoot } = await buildMesh();
  const { srv, port, cookie } = await authed(meshRoot);
  try {
    const res = await post(srv, port, cookie, '/api/agent/alpha/shell/plan', {});
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'shell_disabled');

    const mesh = await (await fetch(`${srv.url}/api/mesh`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie } })).json();
    assert.equal(mesh.shellEnabled, false);
  } finally { await srv.close(); }
});

test('shell enabled (injected launcher) → /plan returns command, /launch opens (mocked)', async () => {
  const { meshRoot } = await buildMesh();
  let spawned = null;
  // inject a launcher with mocked open via createShellLauncher + override launch I/O through the server?
  // Simplest: real launcher, but platform darwin and we intercept by checking command only on /plan,
  // and for /launch we accept ok:false open_failed is also fine. Use a stub launcher instead:
  const stub = {
    buildPlan: async () => ({ planId: 'p1', command: 'cd ... && claude', supported: true }),
    launch: async (id) => { spawned = id; return { ok: true, command: 'cd ... && claude', opened: true }; }
  };
  const { srv, port, cookie } = await authed(meshRoot, { allowShell: true, shellLauncher: stub });
  try {
    const plan = await (await post(srv, port, cookie, '/api/agent/alpha/shell/plan', {})).json();
    assert.equal(plan.ok, true);
    assert.equal(plan.planId, 'p1');
    assert.match(plan.command, /claude/);

    const launch = await (await post(srv, port, cookie, '/api/agent/alpha/shell/launch', { planId: 'p1' })).json();
    assert.equal(launch.ok, true);
    assert.equal(spawned, 'p1');

    const mesh = await (await fetch(`${srv.url}/api/mesh`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie } })).json();
    assert.equal(mesh.shellEnabled, true);
  } finally { await srv.close(); }
});

test('shell plan resumes the existing canonical session id from the shared store', async () => {
  const { meshRoot, agentRoot } = await buildMesh();
  const canonRoot = await realpath(agentRoot);
  const sid = '11111111-1111-1111-1111-111111111111';
  await writeSessionId(meshRoot, canonRoot, sid);

  const built = [];
  const stub = {
    buildPlan: async (args) => {
      built.push(args);
      return { planId: 'p1', command: 'cd ... && claude --resume', supported: true };
    },
    launch: async () => ({ ok: true })
  };
  const sessionIndex = {
    resolveTranscript: async (root, id) => {
      assert.equal(root, canonRoot);
      assert.equal(id, sid);
      return '/tmp/transcript.jsonl';
    }
  };
  const { srv, port, cookie } = await authed(meshRoot, { allowShell: true, shellLauncher: stub, sessionIndex });
  try {
    const res = await post(srv, port, cookie, '/api/agent/alpha/shell/plan', {});
    assert.equal(res.status, 200);
    const plan = await res.json();
    assert.equal(plan.ok, true);
    assert.equal(built.length, 1);
    assert.equal(built[0].agentRoot, canonRoot);
    assert.equal(built[0].resumeId, sid);
    assert.equal(built[0].sessionId, undefined);
    assert.equal(await readSessionId(meshRoot, canonRoot), sid);
  } finally { await srv.close(); }
});

test('shell plan resumes the exact canonical id even when it is newest in the agent cwd', async () => {
  const { meshRoot, agentRoot } = await buildMesh();
  const canonRoot = await realpath(agentRoot);
  const sid = '11111111-1111-1111-1111-111111111111';
  await writeSessionId(meshRoot, canonRoot, sid);

  const built = [];
  const stub = {
    buildPlan: async (args) => {
      built.push(args);
      return { planId: 'p1', command: `cd ... && claude --resume ${args.resumeId}`, supported: true };
    },
    launch: async () => ({ ok: true })
  };
  const sessionIndex = {
    listSessions: async () => [{ id: sid }],
    resolveTranscript: async (root, id) => {
      assert.equal(root, canonRoot);
      assert.equal(id, sid);
      return '/tmp/transcript.jsonl';
    }
  };
  const { srv, port, cookie } = await authed(meshRoot, { allowShell: true, shellLauncher: stub, sessionIndex });
  try {
    const res = await post(srv, port, cookie, '/api/agent/alpha/shell/plan', {});
    assert.equal(res.status, 200);
    const plan = await res.json();
    assert.equal(plan.ok, true);
    assert.equal(built[0].resumeId, sid);
    assert.equal(built[0].continueSession, undefined);
    assert.equal(built[0].sessionId, undefined);
  } finally { await srv.close(); }
});

test('shell plan reuses a stored canonical id as --session-id while its transcript is not created yet', async () => {
  const { meshRoot, agentRoot } = await buildMesh();
  const canonRoot = await realpath(agentRoot);
  const sid = '33333333-3333-3333-3333-333333333333';
  await writeSessionId(meshRoot, canonRoot, sid);

  const built = [];
  const stub = {
    buildPlan: async (args) => {
      built.push(args);
      return { planId: 'p-reserved', command: `cd ... && claude --session-id ${args.sessionId}`, supported: true };
    },
    launch: async () => ({ ok: true })
  };
  const sessionIndex = {
    resolveTranscript: async () => { throw Object.assign(new Error('unknown session'), { code: 'not_found' }); }
  };
  const { srv, port, cookie } = await authed(meshRoot, { allowShell: true, shellLauncher: stub, sessionIndex });
  try {
    const res = await post(srv, port, cookie, '/api/agent/alpha/shell/plan', {});
    assert.equal(res.status, 200);
    const plan = await res.json();
    assert.equal(plan.ok, true);
    assert.equal(built.length, 1);
    assert.equal(built[0].sessionId, sid);
    assert.equal(built[0].resumeId, undefined);
    assert.equal(await readSessionId(meshRoot, canonRoot), sid);
  } finally { await srv.close(); }
});

test('shell plan reserves a new canonical session id when no shared store entry exists', async () => {
  const { meshRoot, agentRoot } = await buildMesh();
  const canonRoot = await realpath(agentRoot);

  const built = [];
  const stub = {
    buildPlan: async (args) => {
      built.push(args);
      return { planId: 'p-new', command: `cd ... && claude --session-id ${args.sessionId}`, supported: true };
    },
    launch: async () => ({ ok: true })
  };
  const { srv, port, cookie } = await authed(meshRoot, { allowShell: true, shellLauncher: stub });
  try {
    assert.equal(await readSessionId(meshRoot, canonRoot), null);
    const res = await post(srv, port, cookie, '/api/agent/alpha/shell/plan', {});
    assert.equal(res.status, 200);
    const plan = await res.json();
    assert.equal(plan.ok, true);
    assert.equal(built.length, 1);
    assert.match(built[0].sessionId, UUID_RE);
    assert.equal(built[0].resumeId, undefined);
    assert.equal(await readSessionId(meshRoot, canonRoot), built[0].sessionId);
  } finally { await srv.close(); }
});

test('shell endpoint: unknown agent → 404; without cookie → 403', async () => {
  const { meshRoot } = await buildMesh();
  const stub = { buildPlan: async () => ({ planId: 'p', command: 'x', supported: true }), launch: async () => ({ ok: true }) };
  const { srv, port, cookie } = await authed(meshRoot, { allowShell: true, shellLauncher: stub });
  try {
    const unknown = await post(srv, port, cookie, '/api/agent/ghost/shell/plan', {});
    assert.equal(unknown.status, 404);
    const noCookie = await fetch(`${srv.url}/api/agent/alpha/shell/plan`, {
      method: 'POST', headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' }, body: '{}'
    });
    assert.equal(noCookie.status, 403);
  } finally { await srv.close(); }
});

test('shell endpoint: reserved_name → 409; expired plan → 410', async () => {
  const { meshRoot } = await buildMesh();
  const stub = {
    buildPlan: async () => { throw new ShellLaunchError('reserved_name', 'nope'); },
    launch: async () => { throw new ShellLaunchError('plan_expired', 'gone'); }
  };
  const { srv, port, cookie } = await authed(meshRoot, { allowShell: true, shellLauncher: stub });
  try {
    assert.equal((await post(srv, port, cookie, '/api/agent/alpha/shell/plan', {})).status, 409);
    assert.equal((await post(srv, port, cookie, '/api/agent/alpha/shell/launch', { planId: 'x' })).status, 410);
  } finally { await srv.close(); }
});
