import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBrainLoop } from '../src/brains/loop.js';

const tools = {
  specs: [{ name: 'propose_idea' }, { name: 'mesh_status' }],
  dispatch: async (name, args) => {
    if (name === 'propose_idea') return { ok: true, __enrichment: { idea: { title: args.title, note: '' } } };
    if (name === 'mesh_status') return { open_issues: 5 };
    return { error: 'unknown_tool' };
  },
};

test('direct reply, no tools', async () => {
  const brain = async () => ({ reply: 'Hi there.' });
  const out = await runBrainLoop({ systemPrompt: 'sys', messages: [{ role: 'user', text: 'hi' }], tools, brain });
  assert.equal(out.reply, 'Hi there.');
  assert.equal(out.enrichment, null);
});

test('tool call then reply; enrichment captured', async () => {
  const script = [
    { toolCall: { name: 'propose_idea', args: { title: 'Nap pods' } } },
    { reply: 'Captured your idea about nap pods.' },
  ];
  let i = 0;
  const brain = async () => script[i++];
  const out = await runBrainLoop({ systemPrompt: 's', messages: [{ role: 'user', text: 'idea: nap pods' }], tools, brain });
  assert.equal(out.reply, 'Captured your idea about nap pods.');
  assert.deepEqual(out.enrichment, { idea: { title: 'Nap pods', note: '' } });
  assert.equal(out.hops, 2);
});

test('tool result is fed back to the brain', async () => {
  const seen = [];
  const brain = async ({ messages }) => {
    seen.push(messages.map((m) => m.role));
    if (messages.some((m) => m.role === 'tool')) return { reply: 'There are 5 open issues.' };
    return { toolCall: { name: 'mesh_status', args: {} } };
  };
  const out = await runBrainLoop({ systemPrompt: 's', messages: [{ role: 'user', text: 'how many issues?' }], tools, brain });
  assert.equal(out.reply, 'There are 5 open issues.');
  assert.ok(seen[1].includes('tool')); // second brain call saw the tool result
});

test('hop budget is bounded (no infinite loop)', async () => {
  const brain = async () => ({ toolCall: { name: 'mesh_status', args: {} } }); // never replies
  const out = await runBrainLoop({ systemPrompt: 's', messages: [{ role: 'user', text: 'x' }], tools, brain, maxHops: 3 });
  assert.equal(out.reply, '');
  assert.equal(out.hops, 3);
});

test('threads the brain usage on the final reply step', async () => {
  const brain = async () => ({ reply: 'done', usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } });
  const out = await runBrainLoop({ systemPrompt: 's', messages: [{ role: 'user', text: 'hi' }], tools, brain });
  assert.deepEqual(out.usage, { input_tokens: 4, output_tokens: 2, total_tokens: 6 });
});

test('usage is null when the brain reports none (and on hop exhaustion)', async () => {
  const noUsage = await runBrainLoop({ systemPrompt: 's', messages: [{ role: 'user', text: 'hi' }], tools, brain: async () => ({ reply: 'x' }) });
  assert.equal(noUsage.usage, null);
  const exhausted = await runBrainLoop({ systemPrompt: 's', messages: [{ role: 'user', text: 'x' }], tools, brain: async () => ({ toolCall: { name: 'mesh_status', args: {} } }), maxHops: 2 });
  assert.equal(exhausted.usage, null);
});
