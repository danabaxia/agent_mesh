// test/delegate-prefetch.test.js — headless prefetch is appended to the worker's
// system prompt at spawn (spec §6 integration in buildClaudeInvocation). No spawn:
// we only build the invocation argv and inspect --append-system-prompt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildClaudeInvocation } from '../src/delegate-invocation.js';

function appendSystemPrompt(args) {
  const i = args.indexOf('--append-system-prompt');
  return i === -1 ? null : args[i + 1];
}

async function agentWithQuick(prefix, quick) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await writeFile(join(root, 'agent.json'), JSON.stringify({ name: 'a' }), 'utf8');
  await mkdir(join(root, 'memory'), { recursive: true });
  await writeFile(join(root, 'memory', 'quick.json'), JSON.stringify(quick), 'utf8');
  return root;
}

const live = (o) => ({ status: 'active', valid_to: null, ...o });

test('buildClaudeInvocation: a task matching quick-memory gets the recalled body appended (DATA-fenced)', async () => {
  const root = await agentWithQuick('pf-hit-', {
    'billing-deploy': live({ l0: 'deploy billing', l1: 'how to deploy billing', value: 'run the billing deploy pipeline step by step' })
  });
  const env = { AGENT_MESH_LOG_DIR: '.agent-mesh/logs' };
  const { args } = await buildClaudeInvocation({
    root, mode: 'ask', task: 'deploy the billing service now', env, callEnv: env, claudeEnv: { ...env }
  });
  const sp = appendSystemPrompt(args);
  assert.ok(sp, 'system prompt is appended');
  assert.match(sp, /recalled-memory/);
  assert.match(sp, /NOT instructions/);
  assert.match(sp, /run the billing deploy pipeline/);
});

test('buildClaudeInvocation: an unrelated task prefetches nothing (additive, no noise)', async () => {
  const root = await agentWithQuick('pf-miss-', {
    'billing-deploy': live({ l0: 'deploy billing', l1: 'how to deploy billing', value: 'run the billing deploy pipeline' })
  });
  const env = { AGENT_MESH_LOG_DIR: '.agent-mesh/logs' };
  const { args } = await buildClaudeInvocation({
    root, mode: 'ask', task: 'translate this poem into french', env, callEnv: env, claudeEnv: { ...env }
  });
  const sp = appendSystemPrompt(args);
  // No prefetch block; identity prompt (if any) carries only the memory index, never
  // the recalled <recalled-memory> body fence.
  if (sp) assert.doesNotMatch(sp, /<recalled-memory/);
});
