import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGemini } from '../src/brains/gemini.js';

test('maps a text response to { reply }', async () => {
  const transport = async () => ({ text: 'A spoken answer.', functionCall: null, usage: { total_cost_usd: 0.001 } });
  const out = await runGemini({ systemPrompt: 's', messages: [{ role: 'user', text: 'hi' }], toolSpecs: [], transport });
  assert.equal(out.reply, 'A spoken answer.');
  assert.equal(out.usage.total_cost_usd, 0.001);
});

test('maps a function-call response to { toolCall }', async () => {
  const transport = async () => ({ text: '', functionCall: { name: 'mesh_status', args: {} } });
  const out = await runGemini({ systemPrompt: 's', messages: [{ role: 'user', text: 'issues?' }], toolSpecs: [{ name: 'mesh_status' }], transport });
  assert.deepEqual(out.toolCall, { name: 'mesh_status', args: {} });
});
