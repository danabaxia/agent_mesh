/**
 * test/skills-policy.test.js — per-agent skill allowlist (PERMISSION surface).
 *
 * Hermetic: discovery + manifest reads use real temp dirs (zero deps).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveSkillPolicy, skillToolEnabled, skillPermissions, isSafeSkillName
} from '../src/skills-policy.js';

// Build a mesh root with one agent that has local skills + global mesh skills.
// `manifestSkills`: pass undefined to OMIT the field, [] to disable, or a list.
async function makeMesh({ localSkills = [], globalSkills = [], manifestSkills } = {}) {
  const meshRoot = await realpath(await mkdtemp(join(tmpdir(), 'sp-mesh-')));
  const agentRel = 'library';
  const agentRoot = join(meshRoot, agentRel);
  await mkdir(join(agentRoot, 'skills'), { recursive: true });
  for (const name of localSkills) {
    await mkdir(join(agentRoot, 'skills', name), { recursive: true });
    await writeFile(join(agentRoot, 'skills', name, 'SKILL.md'), `# ${name}\n`, 'utf8');
  }
  await mkdir(join(meshRoot, 'mesh', 'skills'), { recursive: true });
  for (const name of globalSkills) {
    await mkdir(join(meshRoot, 'mesh', 'skills', name), { recursive: true });
    await writeFile(join(meshRoot, 'mesh', 'skills', name, 'SKILL.md'), `# ${name}\n`, 'utf8');
  }
  const agent = { name: 'library', root: agentRel, card: 'agent.json', served: true, enabledModes: ['ask'], peers: [] };
  if (manifestSkills !== undefined) agent.skills = manifestSkills;
  const manifest = { 'x-agentmesh-generated': true, meshVersion: '1', agents: [agent] };
  await writeFile(join(meshRoot, 'mesh.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return { meshRoot, agentRoot };
}

test('resolveSkillPolicy: skills field ABSENT → mode:all with all discovered names (local ∪ global)', async () => {
  const { meshRoot, agentRoot } = await makeMesh({
    localSkills: ['rich-book-description', 'shelf-answer'],
    globalSkills: ['mesh-wide']
    // manifestSkills omitted → absent
  });
  const policy = await resolveSkillPolicy(agentRoot, meshRoot);
  assert.equal(policy.mode, 'all');
  assert.deepEqual(policy.allow, ['mesh-wide', 'rich-book-description', 'shelf-answer']);
});

test('resolveSkillPolicy: skills:[] → mode:none, empty allow', async () => {
  const { meshRoot, agentRoot } = await makeMesh({
    localSkills: ['rich-book-description'], manifestSkills: []
  });
  const policy = await resolveSkillPolicy(agentRoot, meshRoot);
  assert.deepEqual(policy, { mode: 'none', allow: [] });
});

test('resolveSkillPolicy: skills:[names] → mode:list preserving configured order', async () => {
  const { meshRoot, agentRoot } = await makeMesh({
    localSkills: ['rich-book-description', 'shelf-answer'],
    manifestSkills: ['shelf-answer', 'rich-book-description']
  });
  const policy = await resolveSkillPolicy(agentRoot, meshRoot);
  assert.equal(policy.mode, 'list');
  assert.deepEqual(policy.allow, ['shelf-answer', 'rich-book-description']); // author order kept
});

test('resolveSkillPolicy: malicious skill name in the configured list is DROPPED', async () => {
  const { meshRoot, agentRoot } = await makeMesh({
    localSkills: ['rich-book-description'],
    manifestSkills: ['rich-book-description', 'evil) Skill(*', 'also bad;rm -rf']
  });
  const policy = await resolveSkillPolicy(agentRoot, meshRoot);
  assert.equal(policy.mode, 'list');
  assert.deepEqual(policy.allow, ['rich-book-description']); // only the safe name survives
});

test('resolveSkillPolicy: no meshRoot → mode:all over local skills only', async () => {
  const { agentRoot } = await makeMesh({ localSkills: ['only-local'], manifestSkills: [] });
  // meshRoot null → field cannot be read → absent → all (local only).
  const policy = await resolveSkillPolicy(agentRoot, null);
  assert.equal(policy.mode, 'all');
  assert.deepEqual(policy.allow, ['only-local']);
});

test('isSafeSkillName: charset gate', () => {
  assert.ok(isSafeSkillName('rich-book-description'));
  assert.ok(isSafeSkillName('a_b.c-1'));
  assert.ok(!isSafeSkillName('evil) Skill(*'));
  assert.ok(!isSafeSkillName('has space'));
  assert.ok(!isSafeSkillName(''));
});

test('skillToolEnabled: true for all/list, false for none', () => {
  assert.equal(skillToolEnabled({ mode: 'all', allow: [] }), true);
  assert.equal(skillToolEnabled({ mode: 'list', allow: ['x'] }), true);
  assert.equal(skillToolEnabled({ mode: 'none', allow: [] }), false);
});

test('skillPermissions: all→null, none→deny, list→deny+named-allow', () => {
  assert.equal(skillPermissions({ mode: 'all', allow: ['a'] }), null);
  assert.deepEqual(skillPermissions({ mode: 'none', allow: [] }), { deny: ['Skill'] });
  assert.deepEqual(
    skillPermissions({ mode: 'list', allow: ['rich-book-description', 'shelf-answer'] }),
    { deny: ['Skill'], allow: ['Skill(rich-book-description)', 'Skill(shelf-answer)'] }
  );
});

test('skillPermissions: list defends again at emit time (drops unsafe name)', () => {
  // Belt-and-suspenders: even if an unsafe name reaches here, it is filtered.
  assert.deepEqual(
    skillPermissions({ mode: 'list', allow: ['ok', 'evil) Skill(*'] }),
    { deny: ['Skill'], allow: ['Skill(ok)'] }
  );
});
