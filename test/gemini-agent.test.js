import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGeminiAgent } from '../src/brains/gemini-agent.js';

function agentRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'concierge-'));
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'system.md'), 'You are the concierge.');
  return dir;
}
// A brain that records the systemPrompt it was handed and replies without tools.
function recordingBrain(sink) {
  return async ({ systemPrompt }) => { sink.systemPrompt = systemPrompt; return { reply: 'ok' }; };
}

test('first turn (empty history) annotates the system prompt; second turn does not', async () => {
  const root = agentRoot();
  const sink = {};
  const ctx = 'phone-session-abc';
  await runGeminiAgent({ root, env: {}, input: { mode: 'ask', task: 'hi' }, contextId: ctx, brain: recordingBrain(sink), now: 1 });
  assert.match(sink.systemPrompt, /first turn of this session/i);
  // second turn with the SAME contextId now has history → no first-turn note
  await runGeminiAgent({ root, env: {}, input: { mode: 'ask', task: 'again' }, contextId: ctx, brain: recordingBrain(sink), now: 2 });
  assert.doesNotMatch(sink.systemPrompt, /first turn of this session/i);
});

test('contextId is the history key — different contextIds do not share history', async () => {
  const root = agentRoot();
  const sink = {};
  await runGeminiAgent({ root, env: {}, input: { mode: 'ask', task: 'hi' }, contextId: 'session-A', brain: recordingBrain(sink), now: 1 });
  // a DIFFERENT session is still "first turn"
  await runGeminiAgent({ root, env: {}, input: { mode: 'ask', task: 'hi' }, contextId: 'session-B', brain: recordingBrain(sink), now: 2 });
  assert.match(sink.systemPrompt, /first turn of this session/i);
});
