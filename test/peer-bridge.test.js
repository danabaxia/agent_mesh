/**
 * test/peer-bridge.test.js
 *
 * Inc 1 — readManagedRegistry + the peer-bridge core (ask-only onward delegation).
 * Hermetic: the A2A client is injected as a fake; no real peer spawn.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readManagedRegistry } from '../src/a2a/registry.js';
import { createBridge, buildTools, RESERVED_BRIDGE_ENV, BRIDGE_SERVER_NAME } from '../src/a2a/peer-bridge.js';
import { readRunLogRecords } from '../src/log.js';

// Read all a2a records written under an agent root (newest date file).
async function readA2aRecords(root) {
  const dir = join(root, '.agent-mesh', 'logs');
  let files = [];
  try { files = await readdir(dir); } catch { return []; }
  const a2a = files.filter((f) => f.startsWith('a2a-') && f.endsWith('.jsonl')).sort();
  const out = [];
  for (const f of a2a) out.push(...await readRunLogRecords(join(dir, f)));
  return out;
}

async function agentRootWith(registryObj) {
  const root = await mkdtemp(join(tmpdir(), 'peer-bridge-'));
  if (registryObj !== undefined) {
    await writeFile(join(root, 'registry.json'), JSON.stringify(registryObj), 'utf8');
  }
  return root;
}

// Build an agent root INSIDE a minimal mesh so the bridge can resolve the agent's
// unique manifest name — onward delegation now refuses without a resolvable caller
// (spec §3.5 / Decision 2). Pass `AGENT_MESH_MESH_CEILING: meshRoot` in the bridge env.
async function meshAgentRootWith(registryObj, name = 'caller') {
  const meshRoot = await mkdtemp(join(tmpdir(), 'peer-bridge-mesh-'));
  const root = join(meshRoot, name);
  await mkdir(root, { recursive: true });
  if (registryObj !== undefined) {
    await writeFile(join(root, 'registry.json'), JSON.stringify(registryObj), 'utf8');
  }
  await writeFile(join(meshRoot, 'mesh.json'), JSON.stringify({
    'x-agentmesh-generated': true, meshVersion: '1', agents: [{ name, root: `./${name}` }]
  }), 'utf8');
  return { root, meshRoot, name };
}

const MARKED = {
  'x-agentmesh-generated': true,
  peers: {
    library: {
      root: '/tmp/lib',
      command: 'node',
      args: ['/bin/agent-mesh.js', 'serve-a2a', '/tmp/lib'],
      cwd: '/tmp/lib',
      env: { AGENT_MESH_ENABLED_MODES: 'ask,do' }
    }
  }
};

function doneTask(text = 'Dune is on shelf 3.') {
  return {
    id: 't1',
    status: { state: 'TASK_STATE_COMPLETED', message: { role: 'ROLE_AGENT', parts: [{ text: 'ok' }] }, timestamp: new Date().toISOString() },
    artifacts: [{ artifactId: 't1-s', name: 'summary', parts: [{ text }] }],
    metadata: { 'agentmesh/log_path': '/logs/t1.json', 'agentmesh/files_changed': null }
  };
}

function failedTask() {
  return {
    id: 't2',
    status: { state: 'TASK_STATE_REJECTED', message: { role: 'ROLE_AGENT', parts: [{ text: 'no such mode' }] }, timestamp: new Date().toISOString() },
    artifacts: [],
    metadata: { 'agentmesh/error_code': 'mode_disabled', 'agentmesh/log_path': '/logs/t2.json' }
  };
}

function fakeClientFactory({ task = doneTask() } = {}) {
  const calls = { factory: [], sent: [], closed: 0 };
  const factory = async (registry, options) => {
    calls.factory.push({ registry, options });
    return {
      async send(peer, message) { calls.sent.push({ peer, message }); return task; },
      async close() { calls.closed++; }
    };
  };
  return { factory, calls };
}

// ---------------------------------------------------------------------------
// readManagedRegistry
// ---------------------------------------------------------------------------

test('readManagedRegistry: marked registry yields peers', async () => {
  const root = await agentRootWith(MARKED);
  const r = await readManagedRegistry(root);
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.registry.peers), ['library']);
});

test('readManagedRegistry: markerless registry yields no peers', async () => {
  const root = await agentRootWith({ peers: MARKED.peers }); // no marker
  const r = await readManagedRegistry(root);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'stale_registry');
  assert.deepEqual(r.registry.peers, {});
});

test('readManagedRegistry: bare/array peers yields no peers', async () => {
  const root = await agentRootWith({ 'x-agentmesh-generated': true, peers: [] });
  const r = await readManagedRegistry(root);
  assert.equal(r.ok, false);
  assert.deepEqual(r.registry.peers, {});
});

test('readManagedRegistry: absent registry yields no peers', async () => {
  const root = await agentRootWith(undefined);
  const r = await readManagedRegistry(root);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'absent');
});

// ---------------------------------------------------------------------------
// bridge.listPeers
// ---------------------------------------------------------------------------

test('listPeers reflects the managed registry (enriched with the peer description)', async () => {
  const root = await agentRootWith(MARKED);
  const bridge = createBridge({ root, env: {}, createClient: fakeClientFactory().factory });
  const peers = await bridge.listPeers();
  assert.deepEqual(peers.map((p) => p.name), ['library']);
  // discovery enrichment: a description field is always present (peer's bounded
  // AGENT.md text, a fallback note, or null when the root is unusable)
  assert.ok('description' in peers[0]);
});

test('listPeers is empty for a markerless registry', async () => {
  const root = await agentRootWith({ peers: MARKED.peers });
  const bridge = createBridge({ root, env: {}, createClient: fakeClientFactory().factory });
  assert.deepEqual(await bridge.listPeers(), []);
});

// ---------------------------------------------------------------------------
// delegateToPeer — happy path
// ---------------------------------------------------------------------------

test('delegateToPeer(ask) routes an ask message and maps the final Task', async () => {
  const { root, meshRoot, name } = await meshAgentRootWith(MARKED);
  const { factory, calls } = fakeClientFactory();
  const bridge = createBridge({ root, env: { AGENT_MESH_MODE: 'ask', AGENT_MESH_MESH_CEILING: meshRoot }, createClient: factory });

  const res = await bridge.delegateToPeer({ peer: 'library', mode: 'ask', task: 'find Dune' });
  assert.equal(res.ok, true);
  assert.equal(res.status, 'completed');
  assert.match(res.summary, /shelf 3/);
  assert.equal(res.log_path, '/logs/t1.json');

  // message + options assertions
  assert.equal(calls.sent.length, 1);
  assert.equal(calls.sent[0].peer, 'library');
  assert.equal(calls.sent[0].message.metadata['agentmesh/mode'], 'ask');
  assert.equal(calls.sent[0].message.metadata['agentmesh/caller'], name);
  assert.equal(calls.sent[0].message.parts[0].text, 'find Dune');
  // reserved env protection is requested
  for (const k of RESERVED_BRIDGE_ENV) {
    assert.ok(calls.factory[0].options.protectedEnv.includes(k), `protects ${k}`);
  }
  assert.equal(calls.closed, 1);
});

test('buildTools: delegate_to_peer mode field has no enum restriction (I6 schema fix)', () => {
  const tool = buildTools().find(t => t.name === 'delegate_to_peer');
  const modeProp = tool.inputSchema.properties.mode;
  assert.ok(!modeProp.enum, 'mode must not have enum — schema restriction removed so mode:do reaches the bridge gate');
  assert.equal(modeProp.minLength, 1);
});

test('delegateToPeer defaults mode to ask', async () => {
  const { root, meshRoot } = await meshAgentRootWith(MARKED);
  const { factory, calls } = fakeClientFactory();
  const bridge = createBridge({ root, env: { AGENT_MESH_MESH_CEILING: meshRoot }, createClient: factory });
  const res = await bridge.delegateToPeer({ peer: 'library', task: 'hi' });
  assert.equal(res.ok, true);
  assert.equal(calls.sent[0].message.metadata['agentmesh/mode'], 'ask');
});

// ---------------------------------------------------------------------------
// delegateToPeer — gates (no spawn)
// ---------------------------------------------------------------------------

test('delegateToPeer(do) from ask-mode parent → readonly_parent, NO peer spawn', async () => {
  const root = await agentRootWith(MARKED);
  const { factory, calls } = fakeClientFactory();
  // env.AGENT_MESH_MODE absent or 'ask' → parent is ask-mode → do is refused
  const bridge = createBridge({ root, env: {}, createClient: factory });
  const res = await bridge.delegateToPeer({ peer: 'library', mode: 'do', task: 'rm -rf' });
  assert.equal(res.ok, false);
  assert.equal(res.error_code, 'readonly_parent');
  assert.equal(calls.factory.length, 0, 'must not construct a client for do from ask parent');
});

test('delegateToPeer unknown peer → bad_input, no spawn', async () => {
  const root = await agentRootWith(MARKED);
  const { factory, calls } = fakeClientFactory();
  const bridge = createBridge({ root, env: {}, createClient: factory });
  const res = await bridge.delegateToPeer({ peer: 'ghost', mode: 'ask', task: 'x' });
  assert.equal(res.ok, false);
  assert.equal(res.error_code, 'bad_input');
  assert.equal(calls.factory.length, 0);
});

test('delegateToPeer with markerless registry → bad_input (no peers), no spawn', async () => {
  const root = await agentRootWith({ peers: MARKED.peers }); // unmarked
  const { factory, calls } = fakeClientFactory();
  const bridge = createBridge({ root, env: {}, createClient: factory });
  const res = await bridge.delegateToPeer({ peer: 'library', mode: 'ask', task: 'x' });
  assert.equal(res.ok, false);
  assert.equal(res.error_code, 'bad_input');
  assert.equal(calls.factory.length, 0);
});

test('delegateToPeer empty/oversized task → bad_input', async () => {
  const root = await agentRootWith(MARKED);
  const bridge = createBridge({ root, env: {}, createClient: fakeClientFactory().factory });
  assert.equal((await bridge.delegateToPeer({ peer: 'library', task: '  ' })).error_code, 'bad_input');
  assert.equal((await bridge.delegateToPeer({ peer: 'library', task: 'x'.repeat(20000) })).error_code, 'bad_input');
});

// ---------------------------------------------------------------------------
// audit propagation on downstream failure
// ---------------------------------------------------------------------------

test('a failed peer Task preserves error_code + log_path in the result', async () => {
  const { root, meshRoot } = await meshAgentRootWith(MARKED);
  const { factory } = fakeClientFactory({ task: failedTask() });
  const bridge = createBridge({ root, env: { AGENT_MESH_MESH_CEILING: meshRoot }, createClient: factory });
  const res = await bridge.delegateToPeer({ peer: 'library', mode: 'ask', task: 'x' });
  assert.equal(res.ok, false);
  assert.equal(res.status, 'rejected');
  assert.equal(res.error_code, 'mode_disabled');
  assert.equal(res.log_path, '/logs/t2.json');
});

test('reserved bridge server name carries the framework prefix', () => {
  assert.ok(BRIDGE_SERVER_NAME.startsWith('agentmesh_'));
});

// ---------------------------------------------------------------------------
// a2a audit log — Task 1
// ---------------------------------------------------------------------------

test('delegateToPeer(ask) writes a2a started+done records under the caller root', async () => {
  const { root, meshRoot, name } = await meshAgentRootWith(MARKED);
  const { factory } = fakeClientFactory();                       // doneTask(): completed, log_path /logs/t1.json
  const bridge = createBridge({ root, env: { AGENT_MESH_MESH_CEILING: meshRoot, AGENT_MESH_RUN_ID: 'run-parent' }, createClient: factory });

  await bridge.delegateToPeer({ peer: 'library', mode: 'ask', task: 'find Dune' });

  const recs = await readA2aRecords(root);
  const started = recs.find((r) => r.state === 'started');
  const done = recs.find((r) => r.state === 'done');
  assert.ok(started && done, 'both a2a records written');
  assert.equal(started.id, done.id, 'start+done share one id');
  assert.equal(done.kind, 'a2a');
  assert.equal(done.from, name);
  assert.equal(done.to, 'library');
  assert.equal(done.mode, 'ask');
  assert.equal(done.parent_run_id, 'run-parent');
  assert.equal(done.status, 'completed');
  assert.equal(done.child_log_path, '/logs/t1.json');           // on-disk only
  assert.ok(typeof done.finished_at === 'string');
});

test('delegateToPeer refusal (readonly_parent) writes a single a2a done:rejected record, no started', async () => {
  const { root, meshRoot } = await meshAgentRootWith(MARKED);
  const { factory, calls } = fakeClientFactory();
  // AGENT_MESH_MODE absent → parent is ask-mode → do refused as readonly_parent
  const bridge = createBridge({ root, env: { AGENT_MESH_MESH_CEILING: meshRoot }, createClient: factory });

  const res = await bridge.delegateToPeer({ peer: 'library', mode: 'do', task: 'rm -rf' });
  assert.equal(res.error_code, 'readonly_parent');
  assert.equal(calls.factory.length, 0, 'no peer spawn');

  const recs = await readA2aRecords(root);
  assert.equal(recs.filter((r) => r.state === 'started').length, 0, 'no started record on a pre-send refusal');
  const done = recs.find((r) => r.state === 'done');
  assert.ok(done, 'a refusal is still recorded');
  assert.equal(done.status, 'rejected');
  assert.equal(done.error_code, 'readonly_parent');
  assert.equal(done.to, 'library');
});

test('delegateToPeer with no mesh env → caller_identity_unresolved with diagnostic hint', async () => {
  const root = await agentRootWith(MARKED);
  const bridge = createBridge({ root, env: {}, createClient: fakeClientFactory().factory });
  const res = await bridge.delegateToPeer({ peer: 'library', mode: 'ask', task: 'x' });
  assert.equal(res.ok, false);
  assert.equal(res.error_code, 'caller_identity_unresolved');
  // Message must include actionable hint and path context
  assert.ok(/doctor/i.test(res.summary), `summary should mention doctor: ${res.summary}`);
  assert.ok(/AGENT_MESH_MESH_CEILING.*unset/i.test(res.summary) || /unset/i.test(res.summary),
    `summary should mention missing env: ${res.summary}`);
});

test('delegateToPeer with stale AGENT_MESH_MESH_CEILING → caller_identity_unresolved with path hint', async () => {
  // Registry has correct agent-b peer; mesh env points to a non-existent old path.
  // resolveCallerName will fail to match → refusal with the path in the hint.
  const root = await agentRootWith(MARKED);
  const staleMeshRoot = '/old/stale/path';
  const bridge = createBridge({
    root,
    env: { AGENT_MESH_MESH_CEILING: staleMeshRoot },
    createClient: fakeClientFactory().factory
  });
  const res = await bridge.delegateToPeer({ peer: 'library', mode: 'ask', task: 'x' });
  assert.equal(res.ok, false);
  assert.equal(res.error_code, 'caller_identity_unresolved');
  assert.ok(res.summary.includes(staleMeshRoot), `summary must include meshRoot: ${res.summary}`);
  assert.ok(res.summary.includes(root), `summary must include agentRoot: ${res.summary}`);
});

test('delegateToPeer logs started + done:error when the peer send throws (post-dispatch failure)', async () => {
  const { root, meshRoot } = await meshAgentRootWith(MARKED);
  const throwingClient = async () => ({
    async send() { throw new Error('connection reset'); },
    async close() {}
  });
  const bridge = createBridge({ root, env: { AGENT_MESH_MESH_CEILING: meshRoot }, createClient: throwingClient });

  const res = await bridge.delegateToPeer({ peer: 'library', mode: 'ask', task: 'x' });
  assert.equal(res.ok, false);
  assert.equal(res.error_code, 'spawn_failed');

  const recs = await readA2aRecords(root);
  const started = recs.find((r) => r.state === 'started');
  const done = recs.find((r) => r.state === 'done');
  assert.ok(started && done, 'both records written on a post-dispatch failure');
  assert.equal(started.id, done.id);
  assert.equal(done.status, 'error');
});

// ---------------------------------------------------------------------------
// do→do peer delegation (v2 unlock)
// ---------------------------------------------------------------------------

test('delegateToPeer(do) from do-mode parent → succeeds, forwards mode=do, releases lock', async () => {
  const { root, meshRoot, name } = await meshAgentRootWith(MARKED);
  const { factory, calls } = fakeClientFactory();
  let lockAcquired = false;
  let lockReleased = false;
  const fakeLock = async () => {
    lockAcquired = true;
    return { acquired: true, release: async () => { lockReleased = true; } };
  };
  const bridge = createBridge({
    root,
    env: { AGENT_MESH_MODE: 'do', AGENT_MESH_MESH_CEILING: meshRoot },
    createClient: factory,
    acquireLock: fakeLock
  });

  const res = await bridge.delegateToPeer({ peer: 'library', mode: 'do', task: 'write a file' });
  assert.equal(res.ok, true);
  assert.equal(res.status, 'completed');
  assert.ok(lockAcquired, 'lock must be acquired for do→do');
  assert.ok(lockReleased, 'lock must be released after delegation');
  // The forwarded message metadata must carry mode:'do'
  assert.equal(calls.sent[0].message.metadata['agentmesh/mode'], 'do');
  assert.equal(calls.sent[0].message.metadata['agentmesh/caller'], name);
});

test('delegateToPeer(do) from explicit ask-mode parent → readonly_parent, lock never acquired', async () => {
  const { root, meshRoot } = await meshAgentRootWith(MARKED);
  const { factory } = fakeClientFactory();
  let lockAcquired = false;
  const fakeLock = async () => { lockAcquired = true; return { acquired: true, release: async () => {} }; };
  const bridge = createBridge({
    root,
    env: { AGENT_MESH_MODE: 'ask', AGENT_MESH_MESH_CEILING: meshRoot },
    createClient: factory,
    acquireLock: fakeLock
  });

  const res = await bridge.delegateToPeer({ peer: 'library', mode: 'do', task: 'x' });
  assert.equal(res.ok, false);
  assert.equal(res.error_code, 'readonly_parent');
  assert.equal(lockAcquired, false, 'lock must not be acquired when parent is ask-mode');
});

test('delegateToPeer(do) lock timeout → lock_timeout refusal', async () => {
  const { root, meshRoot } = await meshAgentRootWith(MARKED);
  const { factory } = fakeClientFactory();
  const timedOutLock = async () => ({ acquired: false });
  const bridge = createBridge({
    root,
    env: { AGENT_MESH_MODE: 'do', AGENT_MESH_MESH_CEILING: meshRoot },
    createClient: factory,
    acquireLock: timedOutLock
  });

  const res = await bridge.delegateToPeer({ peer: 'library', mode: 'do', task: 'x' });
  assert.equal(res.ok, false);
  assert.equal(res.error_code, 'lock_timeout');
});

test('delegateToPeer(do) result includes peer_changes from downstream task metadata', async () => {
  const { root, meshRoot } = await meshAgentRootWith(MARKED);
  const taskWithChanges = {
    id: 't3',
    status: { state: 'TASK_STATE_COMPLETED', message: { role: 'ROLE_AGENT', parts: [{ text: 'done' }] }, timestamp: new Date().toISOString() },
    artifacts: [{ artifactId: 't3-s', name: 'summary', parts: [{ text: 'wrote foo.txt' }] }],
    metadata: { 'agentmesh/log_path': '/logs/t3.json', 'agentmesh/files_changed': ['foo.txt', 'bar.txt'] }
  };
  const { factory } = fakeClientFactory({ task: taskWithChanges });
  const fakeLock = async () => ({ acquired: true, release: async () => {} });
  const bridge = createBridge({
    root,
    env: { AGENT_MESH_MODE: 'do', AGENT_MESH_MESH_CEILING: meshRoot },
    createClient: factory,
    acquireLock: fakeLock
  });

  const res = await bridge.delegateToPeer({ peer: 'library', mode: 'do', task: 'write stuff' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.peer_changes, ['foo.txt', 'bar.txt']);
  assert.deepEqual(res.files_changed, ['foo.txt', 'bar.txt']); // back-compat alias
});

test('delegateToPeer(do) a2a log record carries peer_changes for downstream accumulation', async () => {
  const { root, meshRoot } = await meshAgentRootWith(MARKED);
  const taskWithChanges = {
    id: 't4',
    status: { state: 'TASK_STATE_COMPLETED', message: { role: 'ROLE_AGENT', parts: [] }, timestamp: new Date().toISOString() },
    artifacts: [],
    metadata: { 'agentmesh/files_changed': ['lib/x.js'], 'agentmesh/log_path': '/logs/t4.json' }
  };
  const { factory } = fakeClientFactory({ task: taskWithChanges });
  const fakeLock = async () => ({ acquired: true, release: async () => {} });
  const bridge = createBridge({
    root,
    env: { AGENT_MESH_MODE: 'do', AGENT_MESH_MESH_CEILING: meshRoot, AGENT_MESH_RUN_ID: 'run-parent' },
    createClient: factory,
    acquireLock: fakeLock
  });

  await bridge.delegateToPeer({ peer: 'library', mode: 'do', task: 'x' });

  const recs = await readA2aRecords(root);
  const done = recs.find((r) => r.state === 'done');
  assert.ok(done, 'done record written');
  assert.deepEqual(done.peer_changes, ['lib/x.js'], 'peer_changes in a2a log for downstream accumulation');
  assert.equal(done.parent_run_id, 'run-parent');
});

// ---------------------------------------------------------------------------
// fan_out_to_peers (v2 — ask-only concurrent delegation)
// ---------------------------------------------------------------------------

const MARKED_TWO_PEERS = {
  'x-agentmesh-generated': true,
  peers: {
    library: {
      root: '/tmp/lib',
      command: 'node',
      args: ['/bin/agent-mesh.js', 'serve-a2a', '/tmp/lib'],
      cwd: '/tmp/lib',
      env: {}
    },
    docs: {
      root: '/tmp/docs',
      command: 'node',
      args: ['/bin/agent-mesh.js', 'serve-a2a', '/tmp/docs'],
      cwd: '/tmp/docs',
      env: {}
    }
  }
};

test('fanOutToPeers(ask) fans out concurrently and returns all results', async () => {
  const { root, meshRoot } = await meshAgentRootWith(MARKED_TWO_PEERS);
  const sentCalls = [];
  const multiFactory = async () => ({
    async send(peer, message) {
      sentCalls.push({ peer, message });
      return doneTask(`result from ${peer}`);
    },
    async close() {}
  });
  const bridge = createBridge({ root, env: { AGENT_MESH_MESH_CEILING: meshRoot }, createClient: multiFactory });

  const res = await bridge.fanOutToPeers({ peers: ['library', 'docs'], task: 'explain X' });
  assert.equal(res.ok, true);
  assert.equal(res.results.length, 2);
  const byPeer = Object.fromEntries(res.results.map((r) => [r.peer, r]));
  assert.equal(byPeer.library.status, 'completed');
  assert.match(byPeer.library.summary, /result from library/);
  assert.equal(byPeer.docs.status, 'completed');
  assert.match(byPeer.docs.summary, /result from docs/);
  // Both peers were actually called
  assert.equal(sentCalls.length, 2);
  assert.ok(sentCalls.some((c) => c.peer === 'library'));
  assert.ok(sentCalls.some((c) => c.peer === 'docs'));
});

test('fanOutToPeers: one peer fails → included in results as data, ok:true overall', async () => {
  const { root, meshRoot } = await meshAgentRootWith(MARKED_TWO_PEERS);
  const failingFactory = async (registry, options) => ({
    async send(peer) {
      if (peer === 'docs') return failedTask();
      return doneTask('library ok');
    },
    async close() {}
  });
  const bridge = createBridge({ root, env: { AGENT_MESH_MESH_CEILING: meshRoot }, createClient: failingFactory });

  const res = await bridge.fanOutToPeers({ peers: ['library', 'docs'], task: 'ask both' });
  assert.equal(res.ok, true);
  const byPeer = Object.fromEntries(res.results.map((r) => [r.peer, r]));
  assert.equal(byPeer.library.ok, true);
  assert.equal(byPeer.docs.ok, false);
  assert.equal(byPeer.docs.error_code, 'mode_disabled');
});

test('fanOutToPeers: empty peers array → bad_input', async () => {
  const root = await agentRootWith(MARKED_TWO_PEERS);
  const bridge = createBridge({ root, env: {}, createClient: fakeClientFactory().factory });
  const res = await bridge.fanOutToPeers({ peers: [], task: 'x' });
  assert.equal(res.ok, false);
  assert.equal(res.error_code, 'bad_input');
  assert.equal(res.results, null);
});

test('fanOutToPeers: peers not an array → bad_input', async () => {
  const root = await agentRootWith(MARKED_TWO_PEERS);
  const bridge = createBridge({ root, env: {}, createClient: fakeClientFactory().factory });
  const res = await bridge.fanOutToPeers({ peers: 'library', task: 'x' });
  assert.equal(res.ok, false);
  assert.equal(res.error_code, 'bad_input');
});

test('fanOutToPeers: do mode → mode_disabled', async () => {
  const root = await agentRootWith(MARKED_TWO_PEERS);
  const bridge = createBridge({ root, env: { AGENT_MESH_MODE: 'do' }, createClient: fakeClientFactory().factory });
  const res = await bridge.fanOutToPeers({ peers: ['library'], mode: 'do', task: 'x' });
  assert.equal(res.ok, false);
  assert.equal(res.error_code, 'mode_disabled');
  assert.equal(res.results, null);
});

test('fanOutToPeers: unknown peer in list → bad_input before any spawn', async () => {
  const { root, meshRoot } = await meshAgentRootWith(MARKED_TWO_PEERS);
  const { factory, calls } = fakeClientFactory();
  const bridge = createBridge({ root, env: { AGENT_MESH_MESH_CEILING: meshRoot }, createClient: factory });
  const res = await bridge.fanOutToPeers({ peers: ['library', 'ghost'], task: 'x' });
  assert.equal(res.ok, false);
  assert.equal(res.error_code, 'bad_input');
  assert.ok(/ghost/.test(res.summary), `summary names unknown peer: ${res.summary}`);
  assert.equal(calls.factory.length, 0, 'no peer spawned when an unknown peer is in the list');
});

test('fanOutToPeers: markerless registry → bad_input, no spawn', async () => {
  const { root, meshRoot } = await meshAgentRootWith({ peers: MARKED_TWO_PEERS.peers });
  const { factory, calls } = fakeClientFactory();
  const bridge = createBridge({ root, env: { AGENT_MESH_MESH_CEILING: meshRoot }, createClient: factory });
  const res = await bridge.fanOutToPeers({ peers: ['library', 'docs'], task: 'x' });
  assert.equal(res.ok, false);
  assert.equal(res.error_code, 'bad_input');
  assert.equal(calls.factory.length, 0);
});

test('fanOutToPeers: oversized task → bad_input', async () => {
  const root = await agentRootWith(MARKED_TWO_PEERS);
  const bridge = createBridge({ root, env: {}, createClient: fakeClientFactory().factory });
  const res = await bridge.fanOutToPeers({ peers: ['library'], task: 'x'.repeat(20000) });
  assert.equal(res.ok, false);
  assert.equal(res.error_code, 'bad_input');
});

test('buildTools: includes fan_out_to_peers with correct schema', () => {
  const tool = buildTools().find((t) => t.name === 'fan_out_to_peers');
  assert.ok(tool, 'fan_out_to_peers tool present');
  assert.ok(tool.inputSchema.required.includes('peers'));
  assert.ok(tool.inputSchema.required.includes('task'));
  assert.equal(tool.inputSchema.properties.peers.type, 'array');
  assert.equal(tool.inputSchema.properties.peers.minItems, 1);
  assert.equal(tool.inputSchema.properties.peers.maxItems, 10);
});
