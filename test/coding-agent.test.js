import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAgentRuntimePrompt } from '../src/agent-context.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const codingAgentRoot = join(repoRoot, 'examples', 'coding-agent');

test('coding-agent fixture declares a coding A2A peer', async () => {
  const card = JSON.parse(await readFile(join(codingAgentRoot, 'agent.json'), 'utf8'));

  assert.equal(card.protocolVersion, '1.0');
  assert.equal(card.name, 'coding-agent');
  assert.equal(card['x-agentmesh'].modes.includes('ask'), true);
  assert.equal(card['x-agentmesh'].modes.includes('do'), true);
  assert.deepEqual(
    card.skills.map((skill) => skill.id),
    ['code-implementation', 'code-review', 'test-strategy']
  );
});

test('coding-agent public description is separate from runtime prompts', async () => {
  const publicDescription = await readFile(join(codingAgentRoot, 'AGENT.md'), 'utf8');
  assert.match(publicDescription, /public description/i);
  assert.doesNotMatch(publicDescription, /You are the Coding Agent in Agent Mesh/);
});

test('coding-agent runtime prompt includes system, memory, workflows, and mode prompt in order', async () => {
  const prompt = await buildAgentRuntimePrompt(codingAgentRoot, 'ask');
  const expectedOrder = [
    'You are the Coding Agent in Agent Mesh.',
    'Coding Agent profile',
    'Coding standards',
    'Safety policy',
    'Verification policy',
    'Default coding workflow',
    'Ask workflow',
    'You are in ask mode.'
  ];

  let cursor = -1;
  for (const marker of expectedOrder) {
    const idx = prompt.indexOf(marker, cursor + 1);
    assert.ok(idx > cursor, `expected "${marker}" after position ${cursor}, got ${idx}`);
    cursor = idx;
  }
});

test('coding-agent runtime prompt includes deterministic local skill summaries', async () => {
  const prompt = await buildAgentRuntimePrompt(codingAgentRoot, 'ask');

  assert.match(prompt, /Available local skills:/);
  assert.match(prompt, /- code-review: Review scoped code changes for bugs, regressions, missing tests, and maintainability risks\./);
  assert.match(prompt, /- patch-planning: Plan minimal coding patches before implementation\./);
  assert.match(prompt, /- test-strategy: Recommend focused verification commands and test coverage for scoped coding changes\./);
});
