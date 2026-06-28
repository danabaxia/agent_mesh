import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { readBrainKind } from '../src/runner.js';
import { buildToolAdapters } from '../src/brains/tools.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONCIERGE = join(REPO, 'dev-mesh', 'concierge');

test('concierge card declares the gemini brain', async () => {
  assert.equal(await readBrainKind(CONCIERGE), 'gemini');
});

test('concierge stays ask-only in the card', async () => {
  const card = JSON.parse(await readFile(join(CONCIERGE, 'agent.json'), 'utf8'));
  assert.deepEqual(card['x-agentmesh'].modes, ['ask']);
});

test('prompts/system.md is the obeyed prompt and is non-trivial', async () => {
  const sys = await readFile(join(CONCIERGE, 'prompts', 'system.md'), 'utf8');
  assert.ok(sys.trim().length > 80, 'system.md must carry a real persona');
  assert.match(sys, /idea/i); // captures ideas
});

test('AGENT.md is bounded description data (<= 1200 chars, >= 80)', async () => {
  const md = (await readFile(join(CONCIERGE, 'AGENT.md'), 'utf8')).trim();
  assert.ok(md.length >= 80 && md.length <= 1200, `AGENT.md length ${md.length} out of bounds`);
});

test('system prompt names only tools the runner can dispatch', async () => {
  const sys = await readFile(join(CONCIERGE, 'prompts', 'system.md'), 'utf8');
  const dispatchable = new Set(buildToolAdapters({ root: CONCIERGE }).specs.map((s) => s.name));
  // any backticked tool token in the prompt must be a real dispatchable tool
  for (const m of sys.matchAll(/`([a-z_]+)`/g)) {
    const tok = m[1];
    if (['ask', 'do'].includes(tok)) continue;
    assert.ok(dispatchable.has(tok), `system.md references unknown tool \`${tok}\``);
  }
});
