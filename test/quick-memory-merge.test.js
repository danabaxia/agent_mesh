// test/quick-memory-merge.test.js — hermetic tests for the deterministic quick.json
// union resolver used by dev-mesh-memory-automerge to clear conflicting memory PRs.
// Spec: docs/superpowers/specs/2026-06-19-memory-automerge-union-design.md
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeQuickMemory } from '../src/quick-memory-merge.js';
import { validateQuickMemory, MAX_QUICK_ENTRIES, MAX_CORE_ENTRIES } from '../src/quick-memory.js';

const entry = (ts, extra = {}) => ({
  status: 'active', valid_to: null, core: false,
  l0: 'x', l1: 'y', value: 'z', provenance: { source: 's', ts }, ...extra,
});

test('union: keeps keys present on only one side', () => {
  const ours = { a: entry('2026-01-01') };
  const theirs = { b: entry('2026-01-02') };
  const m = mergeQuickMemory(ours, theirs);
  assert.deepEqual(Object.keys(m).sort(), ['a', 'b']);
});

test('union: shared key keeps the newer provenance.ts', () => {
  const ours = { a: entry('2026-01-01', { l0: 'old' }) };
  const theirs = { a: entry('2026-06-01', { l0: 'new' }) };
  assert.equal(mergeQuickMemory(ours, theirs).a.l0, 'new');
  // and the reverse orientation
  assert.equal(mergeQuickMemory(theirs, ours).a.l0, 'new');
});

test('union: equal ts tie goes to ours', () => {
  const ours = { a: entry('2026-01-01', { l0: 'ours' }) };
  const theirs = { a: entry('2026-01-01', { l0: 'theirs' }) };
  assert.equal(mergeQuickMemory(ours, theirs).a.l0, 'ours');
});

test('union: missing provenance.ts is treated as oldest', () => {
  const ours = { a: { status: 'active', valid_to: null, l0: 'noTs' } };
  const theirs = { a: entry('2026-01-01', { l0: 'hasTs' }) };
  assert.equal(mergeQuickMemory(ours, theirs).a.l0, 'hasTs');
});

test('total cap: LRU-evicts oldest non-core, result passes validate', () => {
  const ours = {}, theirs = {};
  // 150 in each, 100 overlapping keys → 200 unique exactly... push over: make 250 unique.
  for (let i = 0; i < 130; i++) ours[`o${i}`] = entry(`2026-01-${String((i % 27) + 1).padStart(2, '0')}`);
  for (let i = 0; i < 130; i++) theirs[`t${i}`] = entry(`2026-05-${String((i % 27) + 1).padStart(2, '0')}`);
  const m = mergeQuickMemory(ours, theirs);
  assert.equal(Object.keys(m).length, MAX_QUICK_ENTRIES, 'trimmed to cap');
  // oldest (the o* January entries) evicted before the newer t* May entries
  assert.ok(Object.keys(m).some((k) => k.startsWith('t')), 'newer side survives');
  assert.doesNotThrow(() => validateQuickMemory(m));
});

test('total cap: core entries are preserved over non-core when evicting', () => {
  const ours = {}, theirs = {};
  // 5 ancient core entries + lots of newer non-core; core must survive the trim
  for (let i = 0; i < 5; i++) ours[`core${i}`] = entry('2020-01-01', { core: true });
  for (let i = 0; i < 210; i++) theirs[`n${i}`] = entry(`2026-05-${String((i % 27) + 1).padStart(2, '0')}`);
  const m = mergeQuickMemory(ours, theirs);
  assert.equal(Object.keys(m).length, MAX_QUICK_ENTRIES);
  for (let i = 0; i < 5; i++) assert.ok(m[`core${i}`], `core${i} preserved despite being oldest`);
  assert.doesNotThrow(() => validateQuickMemory(m));
});

test('core cap: demotes oldest live core to non-core (keeps the lesson)', () => {
  const ours = {};
  for (let i = 0; i < MAX_CORE_ENTRIES + 5; i++) {
    ours[`c${i}`] = entry(`2026-01-${String(i + 1).padStart(2, '0')}`, { core: true });
  }
  const m = mergeQuickMemory(ours, {});
  const liveCore = Object.values(m).filter((e) => e.core && e.status === 'active' && e.valid_to == null).length;
  assert.equal(liveCore, MAX_CORE_ENTRIES, 'core trimmed to cap');
  assert.equal(Object.keys(m).length, MAX_CORE_ENTRIES + 5, 'no entries lost — only demoted');
  assert.equal(m.c0.core, false, 'oldest core demoted');
  assert.equal(m[`c${MAX_CORE_ENTRIES + 4}`].core, true, 'newest core kept');
  assert.doesNotThrow(() => validateQuickMemory(m));
});

test('degrades: empty / non-object inputs yield {}', () => {
  assert.deepEqual(mergeQuickMemory({}, {}), {});
  assert.deepEqual(mergeQuickMemory(null, undefined), {});
});
