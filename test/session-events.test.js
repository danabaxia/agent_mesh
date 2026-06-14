import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEventLine, parseTranscriptLine, redactSessionEvent } from '../src/dashboard/session-events.js';

test('parseTranscriptLine: user string → user_text; assistant tool_use; user tool_result; meta ignored', () => {
  assert.deepEqual(parseTranscriptLine(JSON.stringify({ type: 'user', message: { role: 'user', content: 'find Dune' } })), [{ type: 'user_text', text: 'find Dune' }]);
  assert.deepEqual(parseTranscriptLine(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'T1', name: 'Bash', input: { command: 'ls' } }] } })), [{ type: 'tool_use', id: 'T1', name: 'Bash', input: { command: 'ls' } }]);
  assert.deepEqual(parseTranscriptLine(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'T1', content: 'out' }] } })), [{ type: 'tool_result', toolUseId: 'T1', content: 'out' }]);
  // meta / wrapper records produce no events
  assert.deepEqual(parseTranscriptLine(JSON.stringify({ type: 'mode', mode: 'default', sessionId: 'x' })), []);
  assert.deepEqual(parseTranscriptLine(JSON.stringify({ type: 'attachment', attachment: {} })), []);
  // malformed → raw, never throws
  assert.deepEqual(parseTranscriptLine('not json'), [{ type: 'raw', raw: 'not json' }]);
});

test('redactSessionEvent: deeply nested input does not overflow the stack', () => {
  let nested = 'leaf';
  for (let i = 0; i < 10000; i++) nested = { x: nested };
  let ev;
  assert.doesNotThrow(() => { ev = redactSessionEvent({ type: 'tool_use', id: 'T', name: 'Read', input: nested }); });
  assert.ok(JSON.stringify(ev.input).includes('too deep'));
});

test('redactSessionEvent: secret straddling the cap boundary leaks no prefix', () => {
  // Build a string whose `sk-...` secret begins just before the 20000-char cap.
  const pad = 'a'.repeat(19998);
  const ev = redactSessionEvent({ type: 'text', text: pad + 'sk-SECRETKEYVALUE0123456789' });
  assert.ok(!ev.text.includes('sk-'), 'no sk- prefix should survive in the rendered head');
});

test('parseEventLine: system/init → init event', () => {
  const evs = parseEventLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'S1', model: 'claude', cwd: '/x' }));
  assert.deepEqual(evs, [{ type: 'init', sessionId: 'S1', model: 'claude', cwd: '/x' }]);
});

test('parseEventLine: assistant text + tool_use → one event per block', () => {
  const evs = parseEventLine(JSON.stringify({ type: 'assistant', message: { content: [
    { type: 'text', text: 'hi' },
    { type: 'tool_use', id: 'T1', name: 'Read', input: { file_path: '/a' } }
  ] } }));
  assert.deepEqual(evs, [
    { type: 'text', text: 'hi' },
    { type: 'tool_use', id: 'T1', name: 'Read', input: { file_path: '/a' } }
  ]);
});

test('parseEventLine: user tool_result → tool_result event', () => {
  const evs = parseEventLine(JSON.stringify({ type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 'T1', content: 'file body' }
  ] } }));
  assert.deepEqual(evs, [{ type: 'tool_result', toolUseId: 'T1', content: 'file body' }]);
});

test('parseEventLine: result → turn_done', () => {
  const evs = parseEventLine(JSON.stringify({ type: 'result', subtype: 'success', result: 'done', is_error: false }));
  assert.deepEqual(evs, [{ type: 'turn_done', result: 'done', isError: false }]);
});

test('parseEventLine: malformed / unknown → raw, never throws', () => {
  assert.deepEqual(parseEventLine('not json'), [{ type: 'raw', raw: 'not json' }]);
  assert.deepEqual(parseEventLine(JSON.stringify({ type: 'mystery' })), [{ type: 'raw', raw: '{"type":"mystery"}' }]);
});

test('redactSessionEvent: scrubs secrets in every rendered string field', () => {
  const ev = redactSessionEvent({ type: 'tool_result', toolUseId: 'T1', content: 'API=sk-abcdef 0123456789ABCDEF token' });
  assert.ok(!ev.content.includes('sk-abcdef'));
  assert.ok(ev.content.includes('«redacted»'));
});

test('redactSessionEvent: scrubs nested tool_use.input and caps size', () => {
  const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n');
  const ev = redactSessionEvent({ type: 'tool_use', id: 'T', name: 'Read', input: { q: 'ghp_ABCDEFGHIJKLMNOPQRST12', body: big } });
  assert.ok(!JSON.stringify(ev.input).includes('ghp_ABCDEFGHIJKLMNOPQRST12'));
  assert.ok(JSON.stringify(ev.input).includes('more lines'));   // capped
});
