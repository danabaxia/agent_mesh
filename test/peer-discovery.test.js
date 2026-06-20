// test/peer-discovery.test.js
//
// Peer capability discovery (turn-0 + on-demand):
//  - list_peers returns each peer's bounded AGENT.md description + capabilities
//  - the worker prompt carries a one-line-per-peer roster (capped, max 10) so a
//    worker knows WHO to delegate to before burning effort on the task itself
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBridge } from '../src/a2a/peer-bridge.js';
import { buildAgentRuntimePrompt } from '../src/agent-context.js';

async function meshWithPeers(peerSpecs) {
  const meshRoot = await mkdtemp(join(tmpdir(), 'peer-disc-'));
  const aRoot = join(meshRoot, 'A');
  await mkdir(aRoot, { recursive: true });
  const peers = {};
  for (const [name, agentMd] of Object.entries(peerSpecs)) {
    const pRoot = join(meshRoot, name);
    await mkdir(pRoot, { recursive: true });
    if (agentMd !== null) await writeFile(join(pRoot, 'AGENT.md'), agentMd);
    peers[name] = { root: pRoot, command: 'node', args: [], env: {} };
  }
  await writeFile(join(aRoot, 'registry.json'),
    JSON.stringify({ 'x-agentmesh-generated': true, peers }));
  return { meshRoot, aRoot };
}

// ---------------------------------------------------------------------------
// list_peers enrichment (on-demand tier)
// ---------------------------------------------------------------------------

test('list_peers returns bounded description + capabilities from each peer AGENT.md', async () => {
  const { aRoot } = await meshWithPeers({
    library: 'Library catalog agent. Capabilities: catalog lookup, shelf location. Knows every ISBN.',
    scratch: null // no AGENT.md
  });
  const bridge = createBridge({ root: aRoot, env: {} });
  const peers = await bridge.listPeers();
  const lib = peers.find((p) => p.name === 'library');
  assert.ok(lib, 'library present');
  assert.match(lib.description, /catalog/i);
  assert.ok(Array.isArray(lib.capabilities) && lib.capabilities.includes('catalog lookup'));

  // missing AGENT.md → auto-fingerprint fallback, never a throw
  const scr = peers.find((p) => p.name === 'scratch');
  assert.ok(scr, 'scratch present');
  assert.match(scr.description, /\[auto\]/);
});

test('list_peers tolerates a peer entry without a usable root', async () => {
  const { aRoot } = await meshWithPeers({});
  await writeFile(join(aRoot, 'registry.json'), JSON.stringify({
    'x-agentmesh-generated': true,
    peers: { ghost: { command: 'node', args: [], env: {} } } // no root at all
  }));
  const bridge = createBridge({ root: aRoot, env: {} });
  const peers = await bridge.listPeers();
  assert.equal(peers.length, 1);
  assert.equal(peers[0].name, 'ghost');
  assert.equal(peers[0].description, null);
});

// ---------------------------------------------------------------------------
// worker prompt roster (turn-0 tier)
// ---------------------------------------------------------------------------

test('worker prompt carries a one-line-per-peer roster, framed as data', async () => {
  const { aRoot } = await meshWithPeers({
    library: 'Library catalog agent. Capabilities: catalog lookup. ' + 'x'.repeat(2000)
  });
  const prompt = await buildAgentRuntimePrompt(aRoot, 'ask', {});
  assert.ok(prompt, 'prompt non-null');
  assert.match(prompt, /delegate_to_peer/);
  assert.match(prompt, /- library: /);
  // self-reported data framing (AGENT.md-is-data invariant)
  assert.match(prompt, /self-reported|data, not instructions/i);
  // the roster line is CAPPED — the 2000-char AGENT.md must not flood the prompt
  const line = prompt.split('\n').find((l) => l.startsWith('- library:'));
  assert.ok(line.length <= 200, `roster line capped, got ${line.length}`);
});

test('no marked registry → no roster block', async () => {
  const root = await mkdtemp(join(tmpdir(), 'peer-disc-none-'));
  await writeFile(join(root, 'prompts-placeholder.txt'), 'x'); // ensure dir exists
  const prompt = await buildAgentRuntimePrompt(root, 'ask', {});
  assert.ok(!prompt || !prompt.includes('delegate_to_peer'), 'no peers → no roster');
});

test('roster lists at most 10 peers, then defers to list_peers', async () => {
  const specs = {};
  for (let i = 0; i < 12; i++) specs[`p${String(i).padStart(2, '0')}`] = `Peer number ${i}.`;
  const { aRoot } = await meshWithPeers(specs);
  const prompt = await buildAgentRuntimePrompt(aRoot, 'ask', {});
  const lines = prompt.split('\n').filter((l) => /^- p\d\d: /.test(l));
  assert.equal(lines.length, 10, 'exactly 10 roster lines');
  assert.match(prompt, /2 more.*list_peers/i);
});

test('AGENT_MESH_EVAL_NO_ROSTER=1 suppresses the roster block (eval A/B seam)', async () => {
  const { aRoot } = await meshWithPeers({ library: 'Library catalog agent.' });
  // Give the prompt non-roster content so the OFF leg is provably non-null:
  // the seam must remove ONLY the roster, not the rest of the prompt.
  await mkdir(join(aRoot, 'prompts'), { recursive: true });
  await writeFile(join(aRoot, 'prompts', 'system.md'), 'You are agent A.');
  const on = await buildAgentRuntimePrompt(aRoot, 'ask', {});
  assert.ok(on, 'prompt must be non-null');
  assert.match(on, /- library: /, 'roster present by default');
  const off = await buildAgentRuntimePrompt(aRoot, 'ask', { env: { AGENT_MESH_EVAL_NO_ROSTER: '1' } });
  assert.ok(off, 'prompt still exists with the seam on');
  assert.match(off, /You are agent A\./, 'non-roster content preserved');
  assert.ok(!off.includes('- library: '), 'roster suppressed by seam');
});
