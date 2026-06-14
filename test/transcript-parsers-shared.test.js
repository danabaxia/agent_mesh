import test from 'node:test';
import assert from 'node:assert/strict';
import * as shared from '../src/session-transcripts.js';
import * as events from '../src/dashboard/session-events.js';

test('parseTranscriptLine and redactSessionEvent live in the shared module', () => {
  assert.equal(typeof shared.parseTranscriptLine, 'function');
  assert.equal(typeof shared.redactSessionEvent, 'function');
  assert.equal(shared.parseEventLine, undefined); // stream-json parser stays dashboard-side
});

test('session-events re-exports are the SAME functions (back-compat)', () => {
  assert.equal(events.parseTranscriptLine, shared.parseTranscriptLine);
  assert.equal(events.redactSessionEvent, shared.redactSessionEvent);
});

test('moved redaction still scrubs and the parser still parses', () => {
  const line = JSON.stringify({ type: 'user', message: { content: 'token ghp_abcdefghijklmnopqrstuv plus text' } });
  const [ev] = shared.parseTranscriptLine(line);
  assert.equal(ev.type, 'user_text');
  const red = shared.redactSessionEvent(ev);
  assert.match(red.text, /«redacted»/);
});
