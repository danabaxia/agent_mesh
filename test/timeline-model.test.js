import test from 'node:test';
import assert from 'node:assert/strict';
import { createTimeline, MAX_STITCHED_SEGMENTS, dividerLabel } from '../src/dashboard/public/timeline-model.js';

const meta = (id, origin = 'cli', startedAt = 1) => ({ id, originSource: origin, startedAt });

test('dividerLabel: rotate provenance > origin wording', () => {
  assert.equal(dividerLabel({ originSource: 'headroom' }), 'generation rotated (digest applied)');
  assert.equal(dividerLabel({ originSource: 'cli' }), 'new CLI session');
  assert.equal(dividerLabel({ originSource: 'dashboard' }), 'dashboard session');
});

test('switching follow seals the current segment and appends the new one', () => {
  const tl = createTimeline();
  tl.openSegment(meta('a'));
  tl.append('a', { seq: 1, events: [{ type: 'user_text', text: 'hi' }] });
  tl.openSegment(meta('b', 'cli', 2));
  tl.append('b', { seq: 1, events: [{ type: 'text', text: 'yo' }] });
  const segs = tl.segments();
  assert.deepEqual(segs.map((s) => s.sessionId), ['a', 'b']);
  assert.equal(segs[0].sealed, true);
  assert.equal(segs[0].records.length, 1);          // sealed keeps records
  assert.equal(tl.liveSessionId(), 'b');
});

test('records address as (sessionId, seq): appends to a sealed segment are ignored', () => {
  const tl = createTimeline();
  tl.openSegment(meta('a'));
  tl.openSegment(meta('b'));
  tl.append('a', { seq: 2, events: [] });
  assert.equal(tl.segments()[0].records.length, 0);
});

test('re-opening the SAME id is a no-op (no duplicate segments on poll jitter)', () => {
  const tl = createTimeline();
  tl.openSegment(meta('a'));
  tl.openSegment(meta('a'));
  assert.equal(tl.segments().length, 1);
});

test('eviction beyond MAX_STITCHED_SEGMENTS drops oldest', () => {
  const tl = createTimeline();
  for (let i = 0; i < MAX_STITCHED_SEGMENTS + 2; i++) tl.openSegment(meta(`s${i}`, 'cli', i));
  const segs = tl.segments();
  assert.equal(segs.length, MAX_STITCHED_SEGMENTS);
  assert.equal(segs[0].sessionId, 's2');
});

test('prependHistory loads an older session ABOVE existing segments', () => {
  const tl = createTimeline();
  tl.openSegment(meta('live', 'cli', 10));
  tl.prependHistory(meta('old', 'dashboard', 1), [{ seq: 1, events: [] }]);
  const segs = tl.segments();
  assert.deepEqual(segs.map((s) => s.sessionId), ['old', 'live']);
  assert.equal(segs[0].sealed, true);
});

test('seedLive replaces the live segment records (windowed transcript load)', () => {
  const tl = createTimeline();
  tl.openSegment(meta('a'));
  tl.append('a', { seq: 9, events: [] });
  tl.seedLive('a', [{ seq: 1, events: [] }, { seq: 2, events: [] }]);
  assert.equal(tl.segments()[0].records.length, 2);
  tl.seedLive('other', [{ seq: 1, events: [] }]); // wrong id → no-op
  assert.equal(tl.segments()[0].records.length, 2);
});
