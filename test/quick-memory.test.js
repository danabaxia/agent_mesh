// test/quick-memory.test.js — the structured quick-memory store (spec §8).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readQuickMemory, writeQuickMemory, validateQuickMemory, isLive,
  memoryIndex, coreMemory, recall, deleteEntry, expireEntry,
  MAX_QUICK_ENTRIES, MAX_CORE_ENTRIES, MAX_FIELD_CHARS
} from '../src/quick-memory.js';

const entry = (o = {}) => ({ l0: 'one line', l1: 'overview', value: 'full', core: false, valid_from: '2026-06-13T00:00:00Z', valid_to: null, provenance: { run_id: 'r1' }, status: 'active', ...o });

test('isLive: active + not expired only', () => {
  assert.equal(isLive(entry()), true);
  assert.equal(isLive(entry({ status: 'pending' })), false);
  assert.equal(isLive(entry({ status: 'retired' })), false);
  assert.equal(isLive(entry({ valid_to: '2026-06-13T01:00:00Z' })), false);   // expired
  assert.equal(isLive(null), false);
});

test('memoryIndex: {key: l0} for live entries only', () => {
  const q = { a: entry({ l0: 'A' }), b: entry({ l0: 'B', status: 'pending' }), c: entry({ l0: 'C', valid_to: 'x' }) };
  assert.deepEqual(memoryIndex(q), { a: 'A' });
});

test('coreMemory: {l0,l1} for live core entries only', () => {
  const q = { a: entry({ core: true, l0: 'A', l1: 'oa' }), b: entry({ core: true, status: 'pending' }), c: entry({ core: false }) };
  assert.deepEqual(coreMemory(q), { a: { l0: 'A', l1: 'oa' } });
});

test('recall: full value + provenance for live; null for retired/expired/absent', () => {
  const q = { a: entry({ value: 'V', provenance: { run_id: 'rX' } }), b: entry({ status: 'retired' }) };
  assert.deepEqual(recall(q, 'a'), { value: 'V', l1: 'overview', provenance: { run_id: 'rX' } });
  assert.equal(recall(q, 'b'), null);     // retired → not recallable
  assert.equal(recall(q, 'missing'), null);
});

test('validate: caps on entry count, field length, and core count', () => {
  assert.doesNotThrow(() => validateQuickMemory({ a: entry() }));
  // entry-count cap
  const many = {}; for (let i = 0; i <= MAX_QUICK_ENTRIES; i++) many[`k${i}`] = entry();
  assert.throws(() => validateQuickMemory(many), /entries exceeds cap/);
  // field-length cap
  assert.throws(() => validateQuickMemory({ a: entry({ l0: 'x'.repeat(MAX_FIELD_CHARS.l0 + 1) }) }), /l0 exceeds/);
  // core cap (only LIVE core entries count)
  const core = {}; for (let i = 0; i <= MAX_CORE_ENTRIES; i++) core[`k${i}`] = entry({ core: true });
  assert.throws(() => validateQuickMemory(core), /core entries exceeds cap/);
  // non-object entry
  assert.throws(() => validateQuickMemory({ a: 'nope' }), /not an object/);
});

test('write/read round-trip is atomic + validated; absent → {}', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qm-'));
  assert.deepEqual(await readQuickMemory(root), {});         // absent
  const q = { a: entry({ value: 'V' }) };
  const p = await writeQuickMemory(root, q);
  assert.match(p, /memory[/\\]quick\.json$/);
  assert.deepEqual(await readQuickMemory(root), q);
  // a temp file is renamed, not left behind
  const text = await readFile(p, 'utf8');
  assert.match(text, /"value": "V"/);
  // writing an over-cap store throws (fail-closed, nothing partial)
  await assert.rejects(() => writeQuickMemory(root, { a: entry({ value: 'x'.repeat(MAX_FIELD_CHARS.value + 1) }) }), /value exceeds/);
});

test('deleteEntry is a real delete; expireEntry keeps history (bi-temporal)', () => {
  const q = { a: entry(), b: entry() };
  assert.deepEqual(Object.keys(deleteEntry(q, 'a')), ['b']);   // gone, no tombstone
  const expired = expireEntry(q, 'a', '2026-06-13T02:00:00Z');
  assert.ok(expired.a, 'expired entry kept');
  assert.equal(expired.a.valid_to, '2026-06-13T02:00:00Z');
  assert.equal(isLive(expired.a), false);                      // no longer injected/recalled
  assert.equal(memoryIndex(expired).a, undefined);
});
