import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gatherSignals, buildInspirationPrompt, parseInspiration } from '../src/dev-society/inspiration-digest.js';

const reader = (asOf, data) => async () => ({ asOf, data });

test('gatherSignals flags a stale required source as degraded', async () => {
  const now = 1_000_000_000;
  const staleMs = 1000;
  const s = await gatherSignals({
    mir: reader(now - 5000, { regressions: 2 }),   // stale (older than staleMs)
    gaps: reader(now, { stale: ['#1'] }),
    captures: reader(now, [{ text: 'voice idea' }]),
    activity: reader(now, { runs: 3 }),
  }, { now, staleMs });
  assert.deepEqual(s.degraded, ['mir']);
  assert.equal(s.sources.gaps.asOf, now);
});

test('gatherSignals marks an absent required source degraded, never throws', async () => {
  const now = 5;
  const s = await gatherSignals({
    mir: async () => { throw new Error('no mir'); },
    gaps: reader(now, {}),
    captures: reader(now, []),
    activity: reader(now, {}),
  }, { now, staleMs: 10 });
  assert.ok(s.degraded.includes('mir'));
});

test('buildInspirationPrompt embeds the signals and is a string', async () => {
  const s = await gatherSignals({ mir: reader(1, { x: 1 }), gaps: reader(1, {}), captures: reader(1, [{ text: 'cache STT' }]), activity: reader(1, {}) }, { now: 1, staleMs: 9 });
  const p = buildInspirationPrompt(s, { maxSeeds: 7 });
  assert.equal(typeof p, 'string');
  assert.match(p, /cache STT/);
  assert.match(p, /at most 7/i);
});

test('parseInspiration parses, drops malformed, caps at maxSeeds', () => {
  const good = JSON.stringify({ seeds: [
    { theme: 'a', spark: 's1', why: 'w', sources: [], relatedCaptures: [] },
    { theme: 'b' /* missing spark */ },
    { theme: 'c', spark: 's3', why: 'w', sources: [], relatedCaptures: [] },
  ]});
  const r = parseInspiration(good, { maxSeeds: 1 });
  assert.equal(r.seeds.length, 1);
  assert.equal(r.seeds[0].spark, 's1');
});

test('parseInspiration on garbage → empty, never throws', () => {
  assert.deepEqual(parseInspiration('not json', { maxSeeds: 7 }), { seeds: [] });
  assert.deepEqual(parseInspiration('', { maxSeeds: 7 }), { seeds: [] });
});

// Regression (found via a LIVE analyst run, 2026-06-29): the real analyst replies with a
// fenced ```json block, often wrapped in prose/markdown — bare JSON.parse yielded 0 seeds.
test('parseInspiration extracts seeds from a fenced ```json block amid prose', () => {
  const reply = [
    'Here are the seeds I propose:',
    '```json',
    JSON.stringify({ seeds: [{ theme: 'voice', spark: 'cache STT', why: 'w', sources: [], relatedCaptures: [] }] }),
    '```',
    'Let me know if you want more.',
  ].join('\n');
  const r = parseInspiration(reply, { maxSeeds: 7 });
  assert.equal(r.seeds.length, 1);
  assert.equal(r.seeds[0].spark, 'cache STT');
});

test('parseInspiration uses the LAST fenced block when several are present', () => {
  const reply = '```json\n{"seeds":[{"theme":"a","spark":"first"}]}\n```\n```json\n{"seeds":[{"theme":"b","spark":"last"}]}\n```';
  assert.equal(parseInspiration(reply, { maxSeeds: 7 }).seeds[0].spark, 'last');
});

test('parseInspiration on a markdown table (no json) → empty, never throws', () => {
  const table = '**Regressions only**\n\n| # | ID | Severity |\n|---|----|----------|\n| 1 | p-001 | high |';
  assert.deepEqual(parseInspiration(table, { maxSeeds: 7 }), { seeds: [] });
});

test('buildInspirationPrompt asks for a fenced json block (not prose/tables)', async () => {
  const s = await gatherSignals({ mir: reader(1, {}), gaps: reader(1, {}), captures: reader(1, []), activity: reader(1, {}) }, { now: 1, staleMs: 9 });
  const p = buildInspirationPrompt(s, { maxSeeds: 7 });
  assert.match(p, /```json/);
  assert.match(p, /no prose, no tables/i);
});
