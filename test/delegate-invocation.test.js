import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAskInvocation, buildClaudeEnv, buildClaudeInvocation } from '../src/delegate-invocation.js';

test('buildClaudeEnv: workers get DISABLE_AUTOUPDATER=1 by default (auto-update spawn races), caller override respected', () => {
  // Mesh workers spawn claude constantly; any of them triggering the npm
  // auto-updater swaps the binary under CONCURRENT spawns (observed twice:
  // 2026-06-10 and 2026-06-12T02:42Z spawn ENOENT). Workers must not update.
  const e1 = buildClaudeEnv({ root: 'C:/x', env: {}, mode: 'ask', callEnv: {}, runId: 'r1' });
  assert.equal(e1.DISABLE_AUTOUPDATER, '1');
  // explicit caller choice wins
  const e2 = buildClaudeEnv({ root: 'C:/x', env: { DISABLE_AUTOUPDATER: '0' }, mode: 'ask', callEnv: {}, runId: 'r1' });
  assert.equal(e2.DISABLE_AUTOUPDATER, '0');
});

test('buildAskInvocation: READ_TOOLS only (no mesh) + Skill (all-skills default), strict mcp, settings + setting-sources ""', async () => {
  const root = await mkdtemp(join(tmpdir(), 'di-'));
  await writeFile(join(root, 'agent.json'), JSON.stringify({ name: 'a' }), 'utf8');
  const env = { AGENT_MESH_LOG_DIR: '.agent-mesh/logs' };
  const { args } = await buildAskInvocation({ root, env, callEnv: env, claudeEnv: { ...env } });
  const i = args.indexOf('--tools');
  // No mesh.json reachable → field absent → mode:all → Skill IS added.
  assert.equal(args[i + 1], 'Read,Glob,Grep,LS,Skill');
  assert.ok(!args.join(' ').includes('Bash'));
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(args.includes('--setting-sources'));
  assert.equal(args[args.indexOf('--setting-sources') + 1], '');
});

// Build a mesh whose agent has a configurable skills field, return its agentRoot
// + the env (AGENT_MESH_MESH_ROOT points at the mesh/ subdir, as the registry sets).
async function makeAgent({ localSkills = [], manifestSkills } = {}) {
  const meshRoot = await realpath(await mkdtemp(join(tmpdir(), 'di-mesh-')));
  const agentRoot = join(meshRoot, 'lib');
  await mkdir(join(agentRoot, 'skills'), { recursive: true });
  for (const n of localSkills) {
    await mkdir(join(agentRoot, 'skills', n), { recursive: true });
    await writeFile(join(agentRoot, 'skills', n, 'SKILL.md'), `# ${n}\n`, 'utf8');
  }
  await mkdir(join(meshRoot, 'mesh', 'skills'), { recursive: true });
  const agent = { name: 'lib', root: 'lib', card: 'agent.json', served: true, enabledModes: ['ask'], peers: [] };
  if (manifestSkills !== undefined) agent.skills = manifestSkills;
  await writeFile(join(meshRoot, 'mesh.json'),
    JSON.stringify({ 'x-agentmesh-generated': true, meshVersion: '1', agents: [agent] }), 'utf8');
  const env = {
    AGENT_MESH_LOG_DIR: '.agent-mesh/logs',
    AGENT_MESH_MESH_ROOT: join(meshRoot, 'mesh') // matches registry: the mesh/ dir
  };
  return { meshRoot, agentRoot, env };
}

async function readSettings(args) {
  const p = args[args.indexOf('--settings') + 1];
  return JSON.parse(await readFile(p, 'utf8'));
}

test('buildAskInvocation: restricted agent → Skill in --tools + permissions.deny/allow in settings', async () => {
  const { agentRoot, env } = await makeAgent({
    localSkills: ['rich-book-description', 'shelf-answer'],
    manifestSkills: ['rich-book-description']
  });
  const { args } = await buildAskInvocation({ root: agentRoot, env, callEnv: env, claudeEnv: { ...env } });
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep,LS,Skill'); // list mode still includes Skill
  const settings = await readSettings(args);
  assert.deepEqual(settings.permissions.deny, ['Skill']);
  assert.deepEqual(settings.permissions.allow, ['Skill(rich-book-description)']);
});

test('buildAskInvocation: skills:[] → Skill OMITTED from --tools + deny in settings', async () => {
  const { agentRoot, env } = await makeAgent({ localSkills: ['x'], manifestSkills: [] });
  const { args } = await buildAskInvocation({ root: agentRoot, env, callEnv: env, claudeEnv: { ...env } });
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep,LS'); // NO Skill
  const settings = await readSettings(args);
  assert.deepEqual(settings.permissions.deny, ['Skill']);
});

test('buildAskInvocation: skills absent → Skill in --tools + NO permissions restriction', async () => {
  const { agentRoot, env } = await makeAgent({ localSkills: ['x'] /* no manifestSkills */ });
  const { args } = await buildAskInvocation({ root: agentRoot, env, callEnv: env, claudeEnv: { ...env } });
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep,LS,Skill');
  const settings = await readSettings(args);
  // mode:all → no permissions block injected (may be absent entirely).
  assert.ok(!settings.permissions || !settings.permissions.deny);
});

test('buildClaudeInvocation do-mode: session {id, resume:false} produces --session-id in args', async () => {
  const root = await mkdtemp(join(tmpdir(), 'di-do-session-'));
  await writeFile(join(root, 'agent.json'), JSON.stringify({ name: 'a' }), 'utf8');
  const env = { AGENT_MESH_LOG_DIR: '.agent-mesh/logs' };
  const sessionId = 'dddddddd-1111-4222-8333-444444444444';
  const { args } = await buildClaudeInvocation({
    root, mode: 'do', task: 'do stuff',
    env, callEnv: env, claudeEnv: { ...env },
    session: { id: sessionId, resume: false }
  });
  assert.ok(args.includes('--session-id'), '--session-id flag present in do-mode');
  assert.equal(args[args.indexOf('--session-id') + 1], sessionId, 'session id value correct');
  assert.ok(!args.includes('--resume'), '--resume not present when resume:false');
});
