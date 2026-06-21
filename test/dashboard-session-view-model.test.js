import test from 'node:test';
import assert from 'node:assert/strict';
import { circ, preview, capUtf8, rawFromRecords } from '../src/dashboard/public/session-view-model.js';

test('circ: ①…⑳ for 1-20, then #N fallback', () => {
  assert.equal(circ(1), '①');          // ①
  assert.equal(circ(2), '②');          // ②
  assert.equal(circ(20), '⑳');         // ⑳
  assert.equal(circ(21), '#21');            // out of circled range
  assert.equal(circ(0), '#0');
  assert.equal(circ(-3), '#-3');
});

test('preview: truncates at n chars with " …" suffix; passthrough when short', () => {
  assert.equal(preview('hello', 10), 'hello');         // shorter than n → unchanged
  assert.equal(preview('hello', 5), 'hello');          // exactly n → unchanged (length > n is false)
  assert.equal(preview('hello world', 5), 'hello …');  // longer → slice + " …"
  assert.equal(preview(null, 5), '');                  // nullish → ''
  assert.equal(preview(undefined, 5), '');
});

test('capUtf8: caps a string at max UTF-8 bytes (binary search boundary)', () => {
  assert.equal(capUtf8('hello', 100), 'hello');        // under cap → unchanged
  assert.equal(capUtf8('hello', 3), 'hel');            // ascii: 1 byte/char
  // multibyte: '€' is 3 bytes in UTF-8
  assert.equal(capUtf8('€€', 6), '€€');                // exactly fits 6 bytes
  assert.equal(capUtf8('€€', 5), '€');                 // 5 bytes → only one € (3) fits, second would be 6
  assert.equal(capUtf8('€€', 2), '');                  // can't fit even one € → empty
  assert.equal(capUtf8('', 10), '');
});

test('rawFromRecords: rebuilds raw-shaped records from redacted events in seq order', () => {
  const records = [
    { seq: 1, events: [
      { type: 'user_text', text: 'hi', ts: '2026-01-01T00:00:00Z' },
      { type: 'text', text: 'hello', ts: '2026-01-01T00:00:01Z' },
    ] },
    { seq: 2, events: [
      { type: 'tool_use', name: 'Read', input: { path: '/x' }, ts: '2026-01-01T00:00:02Z' },
      { type: 'tool_result', text: 'ignored' },     // not a turn-grouping event → dropped
      { type: 'user_text', text: 'sub', sidechain: true }, // sidechain → skipped
    ] },
  ];
  const raw = rawFromRecords(records);
  assert.deepEqual(raw, [
    { type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { content: [{ type: 'text', text: 'hi' }] } },
    { type: 'assistant', timestamp: '2026-01-01T00:00:01Z', message: { content: [{ type: 'text', text: 'hello' }] } },
    { type: 'assistant', timestamp: '2026-01-01T00:00:02Z', message: { content: [{ type: 'tool_use', name: 'Read', input: { path: '/x' } }] } },
  ]);
  // ts coerces to '' when missing/non-string
  assert.deepEqual(rawFromRecords([{ events: [{ type: 'text', text: 'x' }] }]), [
    { type: 'assistant', timestamp: '', message: { content: [{ type: 'text', text: 'x' }] } },
  ]);
  assert.deepEqual(rawFromRecords(null), []);
  assert.deepEqual(rawFromRecords([{}]), []);          // no events
});
