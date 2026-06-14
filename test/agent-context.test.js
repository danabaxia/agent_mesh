import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildAgentRuntimePrompt,
  discoverAgentStructure,
  extractSkillSummary,
  listLocalSkills
} from '../src/agent-context.js';
import { MAX_PROMPT_CHARS } from '../src/config.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

async function tempDir(label) {
  return mkdtemp(join(tmpdir(), `agent-context-${label}-`));
}

test('listLocalSkills discovers skills/, .claude/skills/ and .agent/skills/, deduped by name (skills/ wins)', async () => {
  const root = await tempDir('localskills');
  const skill = (dir, name, body) =>
    mkdir(join(root, ...dir.split('/'), name), { recursive: true })
      .then(() => writeFile(join(root, ...dir.split('/'), name, 'SKILL.md'), body));

  // `shared` exists in all three roots — skills/ must win the dedup.
  await skill('skills', 'shared', '# canonical');
  await skill('.claude/skills', 'shared', '# claude');
  await skill('.agent/skills', 'shared', '# agent');
  // unique skills from each convention
  await skill('skills', 'a-canonical', '# a');
  await skill('.claude/skills', 'b-claude', '# b');
  await skill('.agent/skills', 'c-agent', '# c');
  // a directory without SKILL.md is not a skill
  await mkdir(join(root, '.agent', 'skills', '_not_a_skill'), { recursive: true });

  const got = await listLocalSkills(root);
  assert.deepEqual(got.map((s) => s.name), ['a-canonical', 'b-claude', 'c-agent', 'shared']);
  const shared = got.find((s) => s.name === 'shared');
  assert.ok(shared.path.endsWith(join('skills', 'shared', 'SKILL.md')),
    `shared must resolve to the canonical skills/ copy, got ${shared.path}`);
});

// Spec §9 line 294-295: full assembly order test.
test('buildAgentRuntimePrompt includes system, memory, workflows, mode prompt, global skills, and local skills in the documented order', async () => {
  const meshRoot = await tempDir('mesh');
  const agentRoot = await tempDir('agent');

  await mkdir(join(agentRoot, 'prompts'), { recursive: true });
  await writeFile(join(agentRoot, 'prompts', 'system.md'), 'SECTION_SYSTEM');
  await writeFile(join(agentRoot, 'prompts', 'ask.md'), 'SECTION_PROMPT_ASK');

  await mkdir(join(agentRoot, 'memory'), { recursive: true });
  await writeFile(join(agentRoot, 'memory', 'profile.md'), 'SECTION_PROFILE');
  await writeFile(join(agentRoot, 'memory', 'catalog-policy.md'), 'SECTION_MEMORY_CATALOG');
  await writeFile(join(agentRoot, 'memory', 'decisions.md'), '- 2026-06-03 — SECTION_MEMORY_DECISIONS');

  await mkdir(join(agentRoot, 'workflows'), { recursive: true });
  await writeFile(join(agentRoot, 'workflows', 'default.md'), 'SECTION_WORKFLOW_DEFAULT');
  await writeFile(join(agentRoot, 'workflows', 'ask.md'), 'SECTION_WORKFLOW_ASK');

  await mkdir(join(meshRoot, 'skills', 'cite-fmt'), { recursive: true });
  await writeFile(
    join(meshRoot, 'skills', 'cite-fmt', 'SKILL.md'),
    '---\nname: cite-fmt\ndescription: Shared citation format helper\n---\nBody.'
  );

  await mkdir(join(agentRoot, 'skills', 'shelf-answer'), { recursive: true });
  await writeFile(
    join(agentRoot, 'skills', 'shelf-answer', 'SKILL.md'),
    '---\nname: shelf-answer\ndescription: Local shelf rules\n---\nBody.'
  );

  const prompt = await buildAgentRuntimePrompt(agentRoot, 'ask', { meshRoot });

  const expectedSequence = [
    'SECTION_SYSTEM',
    'SECTION_PROFILE',
    'SECTION_MEMORY_CATALOG',
    '- 2026-06-03 — SECTION_MEMORY_DECISIONS (use recall_decision)',
    'SECTION_WORKFLOW_DEFAULT',
    'SECTION_WORKFLOW_ASK',
    'SECTION_PROMPT_ASK',
    'Available global skills:',
    '- cite-fmt: Shared citation format helper',
    'Available local skills:',
    '- shelf-answer: Local shelf rules'
  ];

  let cursor = -1;
  for (const marker of expectedSequence) {
    const idx = prompt.indexOf(marker, cursor + 1);
    assert.ok(
      idx > cursor,
      `expected "${marker}" to appear after position ${cursor}; got ${idx}\nfull prompt:\n${prompt}`
    );
    cursor = idx;
  }
});

// Spec §9 line 296: graceful degradation on missing dirs.
test('missing directories are ignored without failure', async () => {
  const agentRoot = await tempDir('bare');
  await mkdir(join(agentRoot, 'prompts'), { recursive: true });
  await writeFile(join(agentRoot, 'prompts', 'system.md'), 'ONLY_SYSTEM');

  // No memory/, workflows/, skills/, no mesh — must still succeed.
  const prompt = await buildAgentRuntimePrompt(agentRoot, 'ask', {});
  assert.equal(prompt, 'ONLY_SYSTEM');
});

test('an agent with no prompt material at all returns null', async () => {
  const agentRoot = await tempDir('empty');
  const prompt = await buildAgentRuntimePrompt(agentRoot, 'ask', {});
  assert.equal(prompt, null);
});

// Spec §9 line 297: backward compatibility with the existing fixture.
test('existing examples/agent-b prompts/system.md behavior remains compatible', async () => {
  const agentRoot = join(repoRoot, 'examples', 'agent-b');
  const askPrompt = await buildAgentRuntimePrompt(agentRoot, 'ask', {});
  assert.ok(askPrompt, 'examples/agent-b should produce a non-null prompt');

  const systemBody = (await readFile(join(agentRoot, 'prompts', 'system.md'), 'utf8')).trim();
  const askBody = (await readFile(join(agentRoot, 'prompts', 'ask.md'), 'utf8')).trim();

  const sysIdx = askPrompt.indexOf(systemBody);
  const askIdx = askPrompt.indexOf(askBody);
  assert.ok(sysIdx === 0, `system.md should be the leading section, got idx=${sysIdx}`);
  assert.ok(askIdx > sysIdx, 'ask.md should appear after system.md');
});

// Spec §9 line 298: prompt length must respect MAX_PROMPT_CHARS.
test('prompt length is bounded by MAX_PROMPT_CHARS', async () => {
  const agentRoot = await tempDir('huge');
  await mkdir(join(agentRoot, 'prompts'), { recursive: true });
  await writeFile(join(agentRoot, 'prompts', 'system.md'), 'A'.repeat(MAX_PROMPT_CHARS * 2));

  const prompt = await buildAgentRuntimePrompt(agentRoot, 'ask', {});
  assert.ok(
    prompt.length <= MAX_PROMPT_CHARS,
    `expected length <= ${MAX_PROMPT_CHARS}, got ${prompt.length}`
  );
  assert.ok(prompt.endsWith('... [truncated]'), 'truncation marker must be present');
});

// A single oversized memory file must not consume the whole budget and starve
// later sections (the mode prompt is what defines ask/do behavior).
test('a large memory file is capped per-file so the mode prompt survives', async () => {
  const agentRoot = await tempDir('mem-cap');
  await mkdir(join(agentRoot, 'prompts'), { recursive: true });
  await writeFile(join(agentRoot, 'prompts', 'system.md'), 'SECTION_SYSTEM');
  await writeFile(join(agentRoot, 'prompts', 'ask.md'), 'SECTION_PROMPT_ASK');
  await mkdir(join(agentRoot, 'memory'), { recursive: true });
  await writeFile(join(agentRoot, 'memory', 'profile.md'), 'M'.repeat(MAX_PROMPT_CHARS * 2));

  const prompt = await buildAgentRuntimePrompt(agentRoot, 'ask', {});
  assert.ok(prompt.length <= MAX_PROMPT_CHARS);
  assert.ok(
    prompt.includes('SECTION_PROMPT_ASK'),
    'mode prompt must survive an oversized memory file'
  );
});

// ─── skill summary extraction algorithm (spec §4 lines 130-138) ─────────────

test('extractSkillSummary prefers frontmatter description when name + description present', async () => {
  const dir = await tempDir('skill-fm');
  const file = join(dir, 'SKILL.md');
  await writeFile(
    file,
    '---\nname: my-skill\ndescription: Picks the right shelf.\n---\nA much longer body that must NOT be used.'
  );
  assert.equal(await extractSkillSummary(file), 'Picks the right shelf.');
});

test('extractSkillSummary falls back to first non-empty paragraph when frontmatter is incomplete', async () => {
  const dir = await tempDir('skill-fallback');
  const file = join(dir, 'SKILL.md');
  await writeFile(
    file,
    '---\nname: only-name\n---\n\nFirst paragraph here.\n\nSecond paragraph ignored.'
  );
  assert.equal(await extractSkillSummary(file), 'First paragraph here.');
});

test('extractSkillSummary uses first paragraph when no frontmatter at all', async () => {
  const dir = await tempDir('skill-no-fm');
  const file = join(dir, 'SKILL.md');
  await writeFile(file, 'No frontmatter here.\n\nSecond.');
  assert.equal(await extractSkillSummary(file), 'No frontmatter here.');
});

test('extractSkillSummary caps at 500 characters', async () => {
  const dir = await tempDir('skill-cap');
  const file = join(dir, 'SKILL.md');
  const longDesc = 'Z'.repeat(800);
  await writeFile(file, `---\nname: x\ndescription: ${longDesc}\n---\nbody`);
  const summary = await extractSkillSummary(file);
  assert.ok(summary.length <= 500, `expected <= 500, got ${summary.length}`);
});

test('decisions index keeps only the most recent MAX_DECISIONS_INDEX_LINES bullets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ac-cap-'));
  await mkdir(join(root, 'memory'), { recursive: true });
  const bullets = Array.from({ length: 35 }, (_, i) => `- 2026-06-${String((i % 28) + 1).padStart(2, '0')} — decision number ${i}`).join('\n');
  await writeFile(join(root, 'memory', 'decisions.md'), `# Past decisions\n\n${bullets}\n`);
  const prompt = await buildAgentRuntimePrompt(root, 'ask', { meshRoot: null });
  const indexLines = prompt.split('\n').filter((l) => l.includes('(use recall_decision)'));
  assert.equal(indexLines.length, 30);
  assert.match(prompt, /decision number 34/);   // newest kept
  assert.doesNotMatch(prompt, /decision number 0 /); // oldest dropped
});

// ─── discoverAgentStructure observability snapshot ────────────────────────

test('discoverAgentStructure returns an observability snapshot with memory profile-first ordering', async () => {
  const agentRoot = await tempDir('discover');
  await mkdir(join(agentRoot, 'prompts'), { recursive: true });
  await writeFile(join(agentRoot, 'prompts', 'system.md'), 'sys');
  await writeFile(join(agentRoot, 'prompts', 'ask.md'), 'ask');
  await mkdir(join(agentRoot, 'memory'), { recursive: true });
  await writeFile(join(agentRoot, 'memory', 'profile.md'), 'p');
  await writeFile(join(agentRoot, 'memory', 'aaa-something.md'), 'a');
  await writeFile(join(agentRoot, 'memory', 'catalog-policy.md'), 'c');

  const structure = await discoverAgentStructure(agentRoot, {});
  assert.equal(structure.root, agentRoot);
  assert.equal(structure.meshRoot, null);
  assert.ok(structure.systemPromptPath);
  assert.ok(structure.modePromptPath.ask);
  assert.equal(structure.modePromptPath.do, null);
  // profile.md must be first regardless of alphabetical order
  assert.match(structure.memoryFiles[0], /profile\.md$/);
  // remainder sorted alphabetically: aaa-something.md before catalog-policy.md
  assert.match(structure.memoryFiles[1], /aaa-something\.md$/);
  assert.match(structure.memoryFiles[2], /catalog-policy\.md$/);
  assert.deepEqual(structure.globalSkills, []);
  assert.deepEqual(structure.localSkills, []);
});
