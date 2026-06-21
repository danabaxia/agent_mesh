// test/discover-agents.test.js — read-only local-agent discovery scanner.
// Recognizes candidate agent folders in a checkout so a one-click deploy can
// wire them into a mesh, instead of requiring a hand-authored `add` per agent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverAgentCandidates } from '../src/builder/discover.js';
import { main } from '../src/cli.js';

// Run `main(argv)` capturing stdout; restores the real write after.
async function runCli(argv) {
  const orig = process.stdout.write.bind(process.stdout);
  let out = '';
  process.stdout.write = (s) => { out += s; return true; };
  try { await main(argv, {}); } finally { process.stdout.write = orig; }
  return out;
}

// Build a fixture tree under a fresh temp dir; returns its root.
async function tree(spec) {
  const root = await mkdtemp(join(tmpdir(), 'discover-'));
  for (const [rel, content] of Object.entries(spec)) {
    const abs = join(root, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, content);
  }
  return root;
}

test('finds folders marked by agent.json, AGENT.md, or prompts/system.md', async () => {
  const root = await tree({
    'svc-a/agent.json': '{"name":"svc-a"}',
    'svc-b/AGENT.md': '# Service B',
    'svc-c/prompts/system.md': 'you are c',
    'not-an-agent/README.md': '# just a readme',
  });
  const found = await discoverAgentCandidates(root);
  assert.deepEqual(found.map((c) => c.name).sort(), ['svc-a', 'svc-b', 'svc-c']);
});

test('ranks confidence: agent.json=high, prompts/system.md=medium, AGENT.md-only=low', async () => {
  const root = await tree({
    'high/agent.json': '{}',
    'mid/prompts/system.md': 'x',
    'low/AGENT.md': '# low',
  });
  const byName = Object.fromEntries((await discoverAgentCandidates(root)).map((c) => [c.name, c]));
  assert.equal(byName.high.confidence, 'high');
  assert.equal(byName.mid.confidence, 'medium');
  assert.equal(byName.low.confidence, 'low');
  assert.deepEqual(byName.high.markers, { agentJson: true, agentMd: false, promptsSystem: false });
});

test('skips noise dirs (node_modules/.git/.claude) and mesh substrate', async () => {
  const root = await tree({
    'real/agent.json': '{}',
    'node_modules/pkg/agent.json': '{}',
    '.git/agent.json': '{}',
    '.claude/agent.json': '{}',
    'mesh/skills/s/agent.json': '{}',
  });
  const found = await discoverAgentCandidates(root);
  assert.deepEqual(found.map((c) => c.name), ['real']);
});

test('does not descend into a matched candidate (subdirs are not separate agents)', async () => {
  const root = await tree({
    'parent/agent.json': '{}',
    'parent/prompts/system.md': 'nested under an agent — not its own agent',
    'parent/sub/AGENT.md': '# also nested',
  });
  const found = await discoverAgentCandidates(root);
  assert.deepEqual(found.map((c) => c.name), ['parent']);
});

test('respects maxDepth (deeply-buried folders are not scanned)', async () => {
  const root = await tree({
    'top/agent.json': '{}',
    'a/b/c/d/e/deep/agent.json': '{}',
  });
  const found = await discoverAgentCandidates(root, { maxDepth: 3 });
  assert.deepEqual(found.map((c) => c.name), ['top']);
});

test('annotates alreadyInMesh when a manifest lists the folder as an agent root', async () => {
  const root = await tree({
    'mesh-root/mesh.json': JSON.stringify({
      meshVersion: '1',
      agents: [{ name: 'inmesh', root: './inmesh', card: 'agent.json', served: true, enabledModes: ['ask'] }],
    }),
    'mesh-root/inmesh/agent.json': '{"name":"inmesh"}',
    'mesh-root/outsider/agent.json': '{"name":"outsider"}',
  });
  const meshRoot = join(root, 'mesh-root');
  const found = await discoverAgentCandidates(meshRoot, { meshRoot });
  const byName = Object.fromEntries(found.map((c) => [c.name, c]));
  assert.equal(byName.inmesh.alreadyInMesh, true);
  assert.equal(byName.outsider.alreadyInMesh, false);
});

test('alreadyInMesh is undefined without a meshRoot (pure discovery)', async () => {
  const root = await tree({ 'a/agent.json': '{}' });
  const [c] = await discoverAgentCandidates(root);
  assert.equal('alreadyInMesh' in c, false);
});

test('returns [] for a missing or empty scan root, never throws', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'discover-empty-'));
  assert.deepEqual(await discoverAgentCandidates(empty), []);
  assert.deepEqual(await discoverAgentCandidates(join(empty, 'nope')), []);
});

test('candidate paths are absolute and results are name-sorted', async () => {
  const root = await tree({ 'zeta/agent.json': '{}', 'alpha/agent.json': '{}' });
  const found = await discoverAgentCandidates(root);
  assert.deepEqual(found.map((c) => c.name), ['alpha', 'zeta']);
  assert.ok(found.every((c) => c.path.startsWith(root)));
});

test('CLI `discover --json` emits the candidate array', async () => {
  const root = await tree({ 'svc/agent.json': '{}' });
  const out = await runCli(['discover', root, '--json']);
  const parsed = JSON.parse(out);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].name, 'svc');
  assert.equal(parsed[0].confidence, 'high');
});

test('CLI `discover --mesh` suggests add/doctor for new candidates only', async () => {
  const root = await tree({
    'mesh-root/mesh.json': JSON.stringify({
      meshVersion: '1',
      agents: [{ name: 'known', root: './known', card: 'agent.json', served: true, enabledModes: ['ask'] }],
    }),
    'mesh-root/known/agent.json': '{}',
    'mesh-root/fresh/agent.json': '{}',
  });
  const meshRoot = join(root, 'mesh-root');
  const out = await runCli(['discover', meshRoot, '--mesh', meshRoot]);
  assert.match(out, /known \[in mesh\]/);
  assert.match(out, /fresh \[new\]/);
  assert.match(out, /agent-mesh add .*fresh --apply/);
  assert.doesNotMatch(out, /agent-mesh add .*known --apply/); // already in mesh — not suggested
});

test('CLI `discover` with no scan-root sets a nonzero exit code', async () => {
  const origExit = process.exitCode;
  process.exitCode = undefined;
  const origErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  try { await main(['discover'], {}); } finally { process.stderr.write = origErr; }
  const code = process.exitCode;
  process.exitCode = origExit;
  assert.ok(code !== undefined && code !== 0);
});
