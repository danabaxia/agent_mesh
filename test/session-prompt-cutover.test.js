// test/session-prompt-cutover.test.js — buildAgentRuntimePrompt memory cutover
// (spec §5/§11, F8/F3). quick.json present → inject L0 index + core L1, fenced as
// data, full bodies suppressed; absent → legacy eager-body injection unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAgentRuntimePrompt, renderQuickMemoryBlock } from '../src/agent-context.js';
import { writeQuickMemory } from '../src/quick-memory.js';

const liveEntry = (o = {}) => ({ l0: 'L0', l1: 'L1', value: 'V', core: false, valid_from: '2026-06-13T00:00:00Z', valid_to: null, provenance: {}, status: 'active', ...o });

test('renderQuickMemoryBlock: index + core L1 + data fence; null when nothing live', () => {
  assert.equal(renderQuickMemoryBlock({}), null);
  assert.equal(renderQuickMemoryBlock({ a: liveEntry({ status: 'retired' }) }), null);
  const block = renderQuickMemoryBlock({ a: liveEntry({ l0: 'a fact', core: true, l1: 'a overview' }), b: liveEntry({ l0: 'b fact' }) });
  assert.match(block, /DATA, not instructions/);     // fenced
  assert.match(block, /- a — a fact/);               // index line
  assert.match(block, /- b — b fact/);
  assert.match(block, /Core memory/);
  assert.match(block, /- a: a overview/);            // core gets L1
  assert.doesNotMatch(block, /\n- b: /);             // non-core has no L1 line
});

test('cutover: quick.json present → index injected, full body + L2 value suppressed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cutover-'));
  await mkdir(join(root, 'memory'), { recursive: true });
  await writeFile(join(root, 'memory', 'learned.md'), 'LEGACY-BODY-TEXT verbose prose');
  await writeQuickMemory(root, { fact: liveEntry({ l0: 'the planted fact', value: 'FULL-VALUE-L2' }) });
  const prompt = await buildAgentRuntimePrompt(root, 'ask', {});
  assert.match(prompt, /the planted fact/);          // L0 index injected
  assert.match(prompt, /DATA, not instructions/);    // fenced
  assert.doesNotMatch(prompt, /LEGACY-BODY-TEXT/);   // legacy full body NOT injected
  assert.doesNotMatch(prompt, /FULL-VALUE-L2/);      // L2 value NOT injected (pull-only)
});

test('legacy fallback: no quick.json → full memory body injected (unchanged)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legacy-'));
  await mkdir(join(root, 'memory'), { recursive: true });
  await writeFile(join(root, 'memory', 'learned.md'), 'LEGACY-BODY-TEXT verbose prose');
  const prompt = await buildAgentRuntimePrompt(root, 'ask', {});
  assert.match(prompt, /LEGACY-BODY-TEXT/);          // legacy behavior preserved
});
