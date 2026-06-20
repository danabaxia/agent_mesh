import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentWantsWebTools, buildClaudeInvocation } from '../src/delegate-invocation.js';

function toolsOf(args) {
  const i = args.indexOf('--tools');
  return i === -1 ? [] : args[i + 1].split(',');
}

// Build a temp mesh: <root>/mesh.json + an agent folder.
async function makeMesh({ webTools, served = true, modes = ['ask'] } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mesh-web-')));
  const agentRoot = join(root, 'analyst');
  await mkdir(agentRoot, { recursive: true });
  const analyst = { name: 'analyst', root: './analyst', served, enabledModes: modes, peers: [] };
  if (webTools !== undefined) analyst.webTools = webTools;
  await writeFile(join(root, 'mesh.json'),
    JSON.stringify({ meshVersion: 1, agents: [analyst] }), 'utf8');
  return { manifestRoot: root, agentRoot };
}

test('granted when manifest opts in (served+ask+canonical-root match, non-digest)', async () => {
  const { manifestRoot, agentRoot } = await makeMesh({ webTools: true });
  assert.equal(await agentWantsWebTools({ root: agentRoot, manifestRoot, route: 'scheduled:x' }), true);
});

test('denied when webTools absent/false', async () => {
  const a = await makeMesh({ webTools: false });
  assert.equal(await agentWantsWebTools({ root: a.agentRoot, manifestRoot: a.manifestRoot, route: 'x' }), false);
  const b = await makeMesh({}); // no field
  assert.equal(await agentWantsWebTools({ root: b.agentRoot, manifestRoot: b.manifestRoot, route: 'x' }), false);
});

test('denied on the digest route even when opted in', async () => {
  const { manifestRoot, agentRoot } = await makeMesh({ webTools: true });
  assert.equal(await agentWantsWebTools({ root: agentRoot, manifestRoot, route: 'digest' }), false);
});

test('denied for a non-served agent', async () => {
  const { manifestRoot, agentRoot } = await makeMesh({ webTools: true, served: false });
  assert.equal(await agentWantsWebTools({ root: agentRoot, manifestRoot, route: 'x' }), false);
});

test('denied for a root not matching any manifest agent (spoof)', async () => {
  const { manifestRoot } = await makeMesh({ webTools: true });
  const spoof = await realpath(await mkdtemp(join(tmpdir(), 'spoof-')));
  assert.equal(await agentWantsWebTools({ root: spoof, manifestRoot, route: 'x' }), false);
});

test('denied when manifestRoot is missing/null', async () => {
  assert.equal(await agentWantsWebTools({ root: '/whatever', manifestRoot: null, route: 'x' }), false);
});

test('ask allowlist INCLUDES WebSearch/WebFetch for a granted analyst run', async () => {
  const { manifestRoot, agentRoot } = await makeMesh({ webTools: true });
  const env = { AGENT_MESH_MESH_ROOT: join(manifestRoot, 'mesh'), AGENT_MESH_MESH_CEILING: manifestRoot };
  const { args } = await buildClaudeInvocation({
    root: agentRoot, mode: 'ask', task: 'hi', env, callEnv: env, claudeEnv: {}, route: 'scheduled:analyst-daily-review',
  });
  const tools = toolsOf(args);
  assert.ok(tools.includes('WebSearch') && tools.includes('WebFetch'), `got ${tools}`);
});

test('ask allowlist EXCLUDES web tools on the digest route', async () => {
  const { manifestRoot, agentRoot } = await makeMesh({ webTools: true });
  const env = { AGENT_MESH_MESH_ROOT: join(manifestRoot, 'mesh'), AGENT_MESH_MESH_CEILING: manifestRoot };
  const { args } = await buildClaudeInvocation({
    root: agentRoot, mode: 'ask', task: 'hi', env, callEnv: env, claudeEnv: {}, route: 'digest',
  });
  const tools = toolsOf(args);
  assert.ok(!tools.includes('WebSearch') && !tools.includes('WebFetch'), `got ${tools}`);
});

test('do path never gets web tools even if opted in', async () => {
  const { manifestRoot, agentRoot } = await makeMesh({ webTools: true });
  const env = { AGENT_MESH_MESH_ROOT: join(manifestRoot, 'mesh'), AGENT_MESH_MESH_CEILING: manifestRoot };
  const { args } = await buildClaudeInvocation({
    root: agentRoot, mode: 'do', task: 'hi', env, callEnv: env, claudeEnv: {}, route: 'scheduled:x',
  });
  const tools = toolsOf(args);
  assert.ok(!tools.includes('WebSearch') && !tools.includes('WebFetch'), `got ${tools}`);
});
