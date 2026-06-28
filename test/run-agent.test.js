import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent } from '../src/a2a/run-agent.js';
import { buildTaskFromDelegateResult } from '../src/a2a/protocol.js';

async function geminiRoot() {
  const root = await mkdtemp(join(tmpdir(), 'ra-'));
  await mkdir(join(root, 'prompts'), { recursive: true });
  await writeFile(join(root, 'prompts', 'system.md'), 'You are the concierge.');
  await writeFile(join(root, 'AGENT.md'), 'Concierge: the voice front door for the mesh. Ask-only, answers and captures ideas.');
  await writeFile(join(root, 'agent.json'), JSON.stringify({ 'x-agentmesh': { runner: { kind: 'gemini' } } }));
  return root;
}

test('runAgent routes a gemini card to the gemini brain', async () => {
  const root = await geminiRoot();
  const r = await runAgent({ root, env: {}, input: { mode: 'ask', task: 'hi' }, session: { id: 'c' },
    brain: async () => ({ reply: 'hello from gemini' }),
    deps: { meshStatus: async () => ({}), listAgents: async () => [], askPeer: async () => ({}) } });
  assert.equal(r.status, 'done');
  assert.equal(r.summary, 'hello from gemini');
});

test('enrichment lands in the A2A Task metadata', async () => {
  const result = { status: 'done', summary: 'Got it.', files_changed: null, log_path: '/x', run_id: 'r1', enrichment: { idea: { title: 'T', note: '' } } };
  const task = buildTaskFromDelegateResult({ result, message: { contextId: 'c1' } });
  assert.deepEqual(task.metadata['agentmesh/enrichment'], { idea: { title: 'T', note: '' } });
});

test('no enrichment => key omitted (no undefined leak)', async () => {
  const result = { status: 'done', summary: 'hi', files_changed: null, log_path: '/x', run_id: 'r2' };
  const task = buildTaskFromDelegateResult({ result, message: { contextId: 'c2' } });
  assert.equal('agentmesh/enrichment' in task.metadata, false);
});
