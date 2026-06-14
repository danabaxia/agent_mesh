// test/schedule-cadence.test.js — validateCadence / computeNextRun / describeCadence
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCadence,
  computeNextRun,
  describeCadence,
} from '../src/dashboard/schedule-cadence.js';

// ---------------------------------------------------------------------------
// validateCadence — happy paths
// ---------------------------------------------------------------------------

test('validateCadence accepts daily shape', () => {
  assert.deepEqual(validateCadence({ kind: 'daily', at: '07:00' }), { ok: true });
  assert.deepEqual(validateCadence({ kind: 'daily', at: '23:59' }), { ok: true });
  assert.deepEqual(validateCadence({ kind: 'daily', at: '00:00' }), { ok: true });
});

test('validateCadence accepts weekly shape', () => {
  assert.deepEqual(validateCadence({ kind: 'weekly', day: 'mon', at: '06:30' }), { ok: true });
  assert.deepEqual(validateCadence({ kind: 'weekly', day: 'sun', at: '23:00' }), { ok: true });
  assert.deepEqual(validateCadence({ kind: 'weekly', day: 'fri', at: '12:00' }), { ok: true });
});

test('validateCadence accepts every shape', () => {
  assert.deepEqual(validateCadence({ kind: 'every', minutes: 5 }), { ok: true });
  assert.deepEqual(validateCadence({ kind: 'every', minutes: 30 }), { ok: true });
  assert.deepEqual(validateCadence({ kind: 'every', minutes: 1440 }), { ok: true });
});

// ---------------------------------------------------------------------------
// validateCadence — rejection cases
// ---------------------------------------------------------------------------

test('validateCadence rejects null and non-object', () => {
  assert.equal(validateCadence(null).ok, false);
  assert.equal(validateCadence(undefined).ok, false);
  assert.equal(validateCadence('daily').ok, false);
  assert.equal(validateCadence(42).ok, false);
  assert.equal(validateCadence([]).ok, false);
});

test('validateCadence rejects unknown kind', () => {
  assert.equal(validateCadence({ kind: 'hourly', at: '07:00' }).ok, false);
  assert.equal(validateCadence({ kind: '', at: '07:00' }).ok, false);
  assert.equal(validateCadence({ kind: 'DAILY', at: '07:00' }).ok, false);
});

test('validateCadence rejects bad at format', () => {
  // single-digit hour — not zero-padded
  assert.equal(validateCadence({ kind: 'daily', at: '7:00' }).ok, false);
  // hour out of range
  assert.equal(validateCadence({ kind: 'daily', at: '24:00' }).ok, false);
  // minutes out of range
  assert.equal(validateCadence({ kind: 'daily', at: '07:60' }).ok, false);
  // missing at
  assert.equal(validateCadence({ kind: 'daily' }).ok, false);
  // completely wrong format
  assert.equal(validateCadence({ kind: 'daily', at: 'noon' }).ok, false);
});

test('validateCadence rejects bad weekly day', () => {
  assert.equal(validateCadence({ kind: 'weekly', day: 'monday', at: '07:00' }).ok, false);
  assert.equal(validateCadence({ kind: 'weekly', day: 'Mon', at: '07:00' }).ok, false);
  assert.equal(validateCadence({ kind: 'weekly', day: 'xyz', at: '07:00' }).ok, false);
  // missing day
  assert.equal(validateCadence({ kind: 'weekly', at: '07:00' }).ok, false);
});

test('validateCadence rejects bad every.minutes', () => {
  // too small
  assert.equal(validateCadence({ kind: 'every', minutes: 4 }).ok, false);
  // non-integer
  assert.equal(validateCadence({ kind: 'every', minutes: 5.5 }).ok, false);
  // string
  assert.equal(validateCadence({ kind: 'every', minutes: '30' }).ok, false);
  // missing
  assert.equal(validateCadence({ kind: 'every' }).ok, false);
  // negative
  assert.equal(validateCadence({ kind: 'every', minutes: -10 }).ok, false);
});

// ---------------------------------------------------------------------------
// computeNextRun
// ---------------------------------------------------------------------------

test('computeNextRun daily: returns today-at-time when still ahead of after', () => {
  // after = 2026-06-10 06:00 local; at = 07:00 → same day 07:00 local
  const after = new Date(2026, 5, 10, 6, 0);  // month is 0-indexed
  const result = computeNextRun({ kind: 'daily', at: '07:00' }, after);
  const expected = new Date(2026, 5, 10, 7, 0);
  assert.equal(result.getTime(), expected.getTime());
  assert.ok(result > after, 'result must be strictly after `after`');
});

test('computeNextRun daily: rolls to tomorrow when at-time is past', () => {
  // after = 2026-06-10 09:00 local; at = 07:00 → 2026-06-11 07:00 local
  const after = new Date(2026, 5, 10, 9, 0);
  const result = computeNextRun({ kind: 'daily', at: '07:00' }, after);
  const expected = new Date(2026, 5, 11, 7, 0);
  assert.equal(result.getTime(), expected.getTime());
  assert.ok(result > after);
});

test('computeNextRun daily: exactly-at-boundary rolls to tomorrow (strictly greater)', () => {
  // after = 2026-06-10 07:00 exactly; at = 07:00 → must be strictly > after → tomorrow
  const after = new Date(2026, 5, 10, 7, 0);
  const result = computeNextRun({ kind: 'daily', at: '07:00' }, after);
  const expected = new Date(2026, 5, 11, 7, 0);
  assert.equal(result.getTime(), expected.getTime());
  assert.ok(result > after);
});

test('computeNextRun every: returns after + minutes*60000 exactly', () => {
  const after = new Date(2026, 5, 10, 12, 0);
  const result = computeNextRun({ kind: 'every', minutes: 30 }, after);
  assert.equal(result.getTime(), after.getTime() + 30 * 60000);
  assert.ok(result > after);
});

test('computeNextRun weekly: known fixed date — Wed 2026-06-10 12:00 → weekly mon 06:30 → Mon 2026-06-15 06:30', () => {
  // Wednesday 2026-06-10 12:00 local
  const after = new Date(2026, 5, 10, 12, 0);  // Wed
  const result = computeNextRun({ kind: 'weekly', day: 'mon', at: '06:30' }, after);
  // Next Monday = 2026-06-15
  const expected = new Date(2026, 5, 15, 6, 30);
  assert.equal(result.getTime(), expected.getTime());
  assert.ok(result > after);
});

test('computeNextRun weekly: same day but later time stays same day', () => {
  // Wednesday 2026-06-10 08:00 local; weekly wed 10:00 → same day 10:00
  const after = new Date(2026, 5, 10, 8, 0);   // Wed
  const result = computeNextRun({ kind: 'weekly', day: 'wed', at: '10:00' }, after);
  const expected = new Date(2026, 5, 10, 10, 0);
  assert.equal(result.getTime(), expected.getTime());
  assert.ok(result > after);
});

// ---------------------------------------------------------------------------
// describeCadence
// ---------------------------------------------------------------------------

test('describeCadence returns human-readable strings', () => {
  assert.equal(describeCadence({ kind: 'daily', at: '07:00' }), 'daily · 07:00');
  assert.equal(describeCadence({ kind: 'weekly', day: 'mon', at: '06:30' }), 'weekly · mon 06:30');
  assert.equal(describeCadence({ kind: 'every', minutes: 30 }), 'every 30 min');
  assert.equal(describeCadence({ kind: 'every', minutes: 5 }), 'every 5 min');
});
