// test/drift-watch.test.js — bi-temporal drift watch (spec §10). Pure, no spawn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tallyUsage, stalenessProposals, supersessionProposals, driftProposals } from '../src/drift-watch.js';
import { expireEntry, isLive } from '../src/quick-memory.js';

const live = (o) => ({ status: 'active', valid_to: null, ...o });

test('tallyUsage: counts BOTH recall and prefetch; lastAt = max; bad/unknown ignored', () => {
  const t = tallyUsage([
    { key: 'a', kind: 'recall', at: '2026-06-13T00:00:00Z' },
    { key: 'a', kind: 'prefetch', at: '2026-06-13T12:00:00Z' },
    { key: 'a', kind: 'bogus', at: '2026-06-14T00:00:00Z' },   // unknown kind ignored
    { kind: 'recall', at: 'x' },                                // missing key ignored
    { key: 'b', kind: 'prefetch', at: '2026-06-01T00:00:00Z' }
  ]);
  assert.equal(t.a.count, 2);
  assert.equal(t.a.lastAt, '2026-06-13T12:00:00Z');
  assert.equal(t.b.count, 1);
});

test('stalenessProposals: idle non-core proposed; core exempt; recently-used & non-live excluded; NEVER mutates', () => {
  const quick = {
    'fresh': live({ l0: 'x', valid_from: '2026-01-01T00:00:00Z' }),
    'stale': live({ l0: 'y', valid_from: '2026-01-01T00:00:00Z' }),
    'core-stale': live({ l0: 'z', core: true, valid_from: '2026-01-01T00:00:00Z' }),
    'retired': { status: 'retired', valid_to: null, l0: 'r', valid_from: '2026-01-01T00:00:00Z' }
  };
  const frozen = JSON.parse(JSON.stringify(quick));
  const now = Date.parse('2026-06-14T00:00:00Z');
  const usage = tallyUsage([{ key: 'fresh', kind: 'recall', at: '2026-06-13T00:00:00Z' }]);
  const props = stalenessProposals(quick, usage, { now, staleMs: 30 * 24 * 3600 * 1000 });
  assert.deepEqual(props.map((p) => p.key), ['stale']);     // only the idle, live, non-core entry
  assert.equal(props[0].kind, 'retire');
  assert.deepEqual(quick, frozen, 'drift watch must never mutate the store');
});

test('supersessionProposals: conflicting value → expire proposal; same value or non-live → none', () => {
  const q = { 'k': live({ value: 'old' }) };
  assert.deepEqual(supersessionProposals(q, [{ key: 'k', value: 'new' }]).map((p) => p.kind), ['expire']);
  assert.deepEqual(supersessionProposals(q, [{ key: 'k', value: 'old' }]), []);     // unchanged value
  assert.deepEqual(supersessionProposals({}, [{ key: 'x', value: 'v' }]), []);      // no live entry
});

test('applying an approved expire proposal sets valid_to (history KEPT), entry no longer live (expired ≠ retired)', () => {
  const q = { 'k': live({ value: 'old' }) };
  const after = expireEntry(q, 'k', '2026-06-14T00:00:00Z');
  assert.equal(after.k.valid_to, '2026-06-14T00:00:00Z');
  assert.equal(after.k.value, 'old', 'supersession preserves the old value for history');
  assert.equal(isLive(after.k), false, 'expired entry is excluded from injection/recall');
});

test('driftProposals: staleness + supersession combined, still non-mutating', () => {
  const quick = { 'old-fact': live({ value: 'v1', valid_from: '2026-01-01T00:00:00Z' }) };
  const frozen = JSON.parse(JSON.stringify(quick));
  const props = driftProposals(quick, {}, [{ key: 'old-fact', value: 'v2' }], { now: Date.parse('2026-06-14T00:00:00Z') });
  const kinds = props.map((p) => p.kind).sort();
  assert.deepEqual(kinds, ['expire', 'retire']);
  assert.deepEqual(quick, frozen);
});
