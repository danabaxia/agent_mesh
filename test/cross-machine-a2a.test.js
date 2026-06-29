// Cross-machine A2A: an agent's peer-bridge delegates to a REMOTE agent served over
// HTTP (serve-a2a-http) declared as an HTTP peer (`url`) in a marker-validated
// registry.json. This is the box→Mac concierge→coder path; here the transport is
// localhost (transport-equivalent to the reverse SSH tunnel) and the remote agent
// runs a stub `claude` so the gate stays hermetic (no live model).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createA2AHttpServer } from '../src/a2a/http-server.js';
import { createBridge } from '../src/a2a/peer-bridge.js';

let portCounter = 26747;
const nextPort = () => portCounter++;

// Stub `claude` so the remote agent answers without a live model.
async function createFakeClaude(body) {
  const dir = await mkdtemp(join(tmpdir(), 'fake-claude-'));
  const p = join(dir, 'fake-claude.mjs');
  await writeFile(p, `#!/usr/bin/env node\n${body}\n`);
  await chmod(p, 0o755);
  return p;
}

// A remote agent served over HTTP — stands in for the Mac agent across the tunnel.
async function startRemoteAgent(name, env = {}) {
  const root = await mkdtemp(join(tmpdir(), `remote-${name}-`));
  await writeFile(join(root, 'AGENT.md'), `# ${name}\nRemote ${name} agent reached over cross-machine HTTP A2A. It answers questions about the codebase.`);
  await writeFile(join(root, 'agent.json'), JSON.stringify({ name, 'x-agentmesh': { modes: ['ask'] } }));
  const port = nextPort();
  const server = await createA2AHttpServer({ root, port, host: '127.0.0.1', env });
  const { url } = await server.start();
  return { root, server, url };
}

// A caller agent inside a minimal mesh, with a marker-validated HTTP-peer registry.
async function callerWithHttpPeer(peerName, peerUrl, callerName = 'concierge') {
  const meshRoot = await mkdtemp(join(tmpdir(), 'caller-mesh-'));
  const root = join(meshRoot, callerName);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'registry.json'), JSON.stringify({
    'x-agentmesh-generated': true,
    peers: { [peerName]: { url: peerUrl } },
  }));
  await writeFile(join(meshRoot, 'mesh.json'), JSON.stringify({
    'x-agentmesh-generated': true, meshVersion: '1', agents: [{ name: callerName, root: `./${callerName}` }],
  }));
  return { root, meshRoot, callerName };
}

const OK_ENVELOPE =
  "process.stdout.write(JSON.stringify({type:'result',subtype:'success',result:'REMOTE_OK: '+(process.argv.slice(2).join(' ').slice(0,40)),is_error:false,total_cost_usd:0,num_turns:1,session_id:'s'})); process.exit(0);";

test('cross-machine A2A: peer-bridge delegates over an HTTP-peer registry to a remote served agent and maps the Task', async () => {
  const fakeClaude = await createFakeClaude(OK_ENVELOPE);
  const remote = await startRemoteAgent('coder', { AGENT_MESH_CLAUDE: fakeClaude });
  try {
    const caller = await callerWithHttpPeer('coder', remote.url);
    const bridge = createBridge({
      root: caller.root,
      env: { AGENT_MESH_MODE: 'ask', AGENT_MESH_MESH_CEILING: caller.meshRoot, AGENT_MESH_DEPTH: '3' },
    });
    const r = await bridge.delegateToPeer({ peer: 'coder', mode: 'ask', task: 'what is your role?' });
    assert.equal(r.ok, true, `delegate should succeed: ${JSON.stringify(r)}`);
    assert.match(r.summary, /REMOTE_OK/, `summary should carry the remote agent's answer: ${r.summary}`);
  } finally {
    await remote.server.close();
  }
});

test('cross-machine A2A: an unreachable HTTP peer fails as DATA (no throw, ok:false)', async () => {
  // No server listening on this port → the bridge must return a failed result, not throw.
  const caller = await callerWithHttpPeer('coder', 'http://127.0.0.1:1/rpc');
  const bridge = createBridge({
    root: caller.root,
    env: { AGENT_MESH_MODE: 'ask', AGENT_MESH_MESH_CEILING: caller.meshRoot, AGENT_MESH_DEPTH: '3' },
  });
  const r = await bridge.delegateToPeer({ peer: 'coder', mode: 'ask', task: 'are you there?' });
  assert.equal(r.ok, false);
  assert.ok(['rejected', 'error', 'failed', 'timeout'].includes(r.status), `failure status, got: ${r.status}`);
});

test('cross-machine A2A: a peer not in the registry is refused before any network call', async () => {
  const caller = await callerWithHttpPeer('coder', 'http://127.0.0.1:9/rpc');
  const bridge = createBridge({
    root: caller.root,
    env: { AGENT_MESH_MODE: 'ask', AGENT_MESH_MESH_CEILING: caller.meshRoot, AGENT_MESH_DEPTH: '3' },
  });
  const r = await bridge.delegateToPeer({ peer: 'tester', mode: 'ask', task: 'hi' });
  assert.equal(r.ok, false);
  assert.match(JSON.stringify(r), /unknown_peer|not.*registr|no.*peer/i);
});
