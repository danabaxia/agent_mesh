import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEventLine, redactSessionEvent } from '../src/dashboard/session-events.js';
import { createSessionLive } from '../src/dashboard/session-live.js';

const USAGE = { input_tokens: 9, cache_read_input_tokens: 1, cache_creation_input_tokens: 2, output_tokens: 3 };

test('result events surface usage for the runner', () => {
  const [ev] = parseEventLine(JSON.stringify({ type: 'result', result: 'ok', is_error: false, usage: USAGE }));
  assert.equal(ev.type, 'turn_done');
  assert.deepEqual(ev.usage, USAGE);
});

test('result events without usage omit the field (no null noise)', () => {
  const [ev] = parseEventLine(JSON.stringify({ type: 'result', result: 'ok' }));
  assert.equal('usage' in ev, false);
});

test('usage is a control field: redaction does NOT forward it to the browser', () => {
  const [ev] = parseEventLine(JSON.stringify({ type: 'result', result: 'ok', usage: USAGE }));
  const red = redactSessionEvent(ev);
  assert.equal('usage' in red, false);
});

test('the live-hub fan-out is the enforcement site: subscribers never see usage', () => {
  const live = createSessionLive();
  const sid = 'feedface-0000-4000-8000-000000000000';
  const got = [];
  live.subscribe(sid, (rec) => got.push(rec));
  const [ev] = parseEventLine(JSON.stringify({ type: 'result', result: 'ok', usage: USAGE }));
  live.append(sid, [ev]);
  assert.equal(got.length, 1);
  const sent = got[0].events[0];
  assert.equal(sent.type, 'turn_done');
  assert.equal('usage' in sent, false); // stripped at session-live.append → redactSessionEvent
  assert.deepEqual(ev.usage, USAGE);    // the runner-side event still carries it
});
