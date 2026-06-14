/**
 * test/session-log-streamurl.test.js — the pure past→live handoff cursor helper.
 *
 * streamUrl() builds the live-mirror EventSource URL with the rendered transcript
 * cursor threaded as ?fromSeq, so the live tail starts exactly where the rendered
 * transcript ended (no double-render, no subscribe-at-0 replay_gap loop). No DOM
 * needed — the helper is pure and exported for exactly this.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { HISTORY_PAGE_LIMIT, sessionStartSeq, streamUrl, transcriptWindowUrl, toolStatsFromRecords } from '../src/dashboard/public/session-log.js';

test('streamUrl threads the newest transcript seq as ?fromSeq', () => {
  assert.equal(streamUrl('library', 'abc-123', 7), '/api/agent/library/session/abc-123/stream?fromSeq=7');
});

test('streamUrl can request initial tail-only mode for lazy history', () => {
  assert.equal(streamUrl('library', 'abc-123', 7, { tailOnly: true }), '/api/agent/library/session/abc-123/stream?fromSeq=7&tail=1');
});

test('streamUrl: empty/zero window → fromSeq=0 (replay whatever the mirror has)', () => {
  assert.equal(streamUrl('library', 'id', 0), '/api/agent/library/session/id/stream?fromSeq=0');
  assert.equal(streamUrl('library', 'id', null), '/api/agent/library/session/id/stream?fromSeq=0');
  assert.equal(streamUrl('library', 'id', undefined), '/api/agent/library/session/id/stream?fromSeq=0');
});

test('streamUrl: non-negative integer coercion (no NaN, no negatives, no fractions)', () => {
  assert.equal(streamUrl('a', 'b', -5), '/api/agent/a/session/b/stream?fromSeq=0');
  assert.equal(streamUrl('a', 'b', 3.9), '/api/agent/a/session/b/stream?fromSeq=3');
  assert.equal(streamUrl('a', 'b', 'not-a-number'), '/api/agent/a/session/b/stream?fromSeq=0');
});

test('streamUrl: encodes agent name and id (no injection into path)', () => {
  const u = streamUrl('a/b c', 'id with space', 1);
  assert.equal(u, '/api/agent/a%2Fb%20c/session/id%20with%20space/stream?fromSeq=1');
});

test('sessionStartSeq uses session lineCount as the no-history live cursor', () => {
  assert.equal(sessionStartSeq({ lineCount: 123 }), 123);
  assert.equal(sessionStartSeq({ lineCount: '3.9' }), 3);
  assert.equal(sessionStartSeq({ lineCount: 0 }), 0);
  assert.equal(sessionStartSeq({}), 0);
});

test('transcriptWindowUrl fetches bounded history pages only when requested', () => {
  assert.equal(
    transcriptWindowUrl('library', 'abc-123', { beforeSeq: 124 }),
    `/api/agent/library/session/abc-123/transcript?limit=${HISTORY_PAGE_LIMIT}&beforeSeq=124`
  );
  assert.equal(
    transcriptWindowUrl('a/b c', 'id with space', { beforeSeq: null, limit: 999 }),
    '/api/agent/a%2Fb%20c/session/id%20with%20space/transcript?limit=500'
  );
});

test('toolStatsFromRecords counts calls, unique tools, reuse, and results', () => {
  const summary = toolStatsFromRecords([
    { seq: 1, events: [
      { type: 'tool_use', name: 'Read' },
      { type: 'tool_result', content: 'ok' }
    ] },
    { seq: 2, events: [
      { type: 'tool_use', name: 'Read' },
      { type: 'tool_use', name: 'Grep' }
    ] },
    { seq: 2, events: [
      { type: 'tool_use', name: 'Read' }
    ] }
  ]);
  assert.equal(summary.toolCalls, 3);
  assert.equal(summary.toolResults, 1);
  assert.equal(summary.uniqueTools, 2);
  assert.equal(summary.reuseCount, 1);
  assert.equal(summary.reuseRate, 1 / 3);
  assert.deepEqual(summary.topTools.map((t) => [t.name, t.count]), [['Read', 2], ['Grep', 1]]);
});
