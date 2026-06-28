import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRunnerConfig, parseScriptRunnerResult, readBrainKind } from '../src/runner.js';

// ── readRunnerConfig ──────────────────────────────────────────────────────────

test('readRunnerConfig: no agent.json → null (ClaudeRunner default)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runner-test-'));
  assert.equal(await readRunnerConfig(root), null);
});

test('readRunnerConfig: agent.json without x-agentmesh.runner → null', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runner-test-'));
  await writeFile(join(root, 'agent.json'), JSON.stringify({ name: 'agent' }), 'utf8');
  assert.equal(await readRunnerConfig(root), null);
});

test('readRunnerConfig: x-agentmesh without runner field → null', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runner-test-'));
  await writeFile(join(root, 'agent.json'), JSON.stringify({ 'x-agentmesh': { modes: ['ask'] } }), 'utf8');
  assert.equal(await readRunnerConfig(root), null);
});

test('readRunnerConfig: x-agentmesh.runner.command string → { command }', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runner-test-'));
  await writeFile(join(root, 'agent.json'), JSON.stringify({
    name: 'git-peer',
    'x-agentmesh': { runner: { command: '/usr/local/bin/git-summary.mjs' } }
  }), 'utf8');
  const cfg = await readRunnerConfig(root);
  assert.deepEqual(cfg, { command: '/usr/local/bin/git-summary.mjs' });
});

test('readRunnerConfig: runner.command empty string → null', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runner-test-'));
  await writeFile(join(root, 'agent.json'), JSON.stringify({
    'x-agentmesh': { runner: { command: '' } }
  }), 'utf8');
  assert.equal(await readRunnerConfig(root), null);
});

test('readRunnerConfig: runner.command non-string → null', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runner-test-'));
  await writeFile(join(root, 'agent.json'), JSON.stringify({
    'x-agentmesh': { runner: { command: 42 } }
  }), 'utf8');
  assert.equal(await readRunnerConfig(root), null);
});

test('readRunnerConfig: runner is not an object → null', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runner-test-'));
  await writeFile(join(root, 'agent.json'), JSON.stringify({
    'x-agentmesh': { runner: 'not-an-object' }
  }), 'utf8');
  assert.equal(await readRunnerConfig(root), null);
});

test('readRunnerConfig: corrupt agent.json → null (silent fallback)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runner-test-'));
  await writeFile(join(root, 'agent.json'), '{not valid json', 'utf8');
  assert.equal(await readRunnerConfig(root), null);
});

// ── parseScriptRunnerResult ───────────────────────────────────────────────────

test('parseScriptRunnerResult: valid { summary } → summary with null usage', () => {
  const r = parseScriptRunnerResult(JSON.stringify({ summary: 'done' }));
  assert.equal(r.summary, 'done');
  assert.equal(r.usage, null);
});

test('parseScriptRunnerResult: { summary, usage } → summary + normalized usage', () => {
  const r = parseScriptRunnerResult(JSON.stringify({
    summary: 'finished',
    usage: { input_tokens: 100, output_tokens: 50, total_cost_usd: 0.001, num_turns: 2 }
  }));
  assert.equal(r.summary, 'finished');
  assert.equal(r.usage.input_tokens, 100);
  assert.equal(r.usage.output_tokens, 50);
  assert.equal(r.usage.total_cost_usd, 0.001);
  assert.equal(r.usage.num_turns, 2);
  assert.equal(r.usage.duration_api_ms, null);
  assert.equal(r.usage.session_id, null);
});

test('parseScriptRunnerResult: empty string → null', () => {
  assert.equal(parseScriptRunnerResult(''), null);
  assert.equal(parseScriptRunnerResult('   '), null);
});

test('parseScriptRunnerResult: non-JSON → null', () => {
  assert.equal(parseScriptRunnerResult('plain text output'), null);
  assert.equal(parseScriptRunnerResult('{not json'), null);
});

test('parseScriptRunnerResult: JSON array → null', () => {
  assert.equal(parseScriptRunnerResult('[1,2,3]'), null);
});

test('parseScriptRunnerResult: object without summary field → null', () => {
  assert.equal(parseScriptRunnerResult(JSON.stringify({ result: 'foo' })), null);
  assert.equal(parseScriptRunnerResult(JSON.stringify({ message: 'bar' })), null);
});

test('parseScriptRunnerResult: summary not a string → null', () => {
  assert.equal(parseScriptRunnerResult(JSON.stringify({ summary: 42 })), null);
  assert.equal(parseScriptRunnerResult(JSON.stringify({ summary: null })), null);
});

test('parseScriptRunnerResult: usage array (invalid) → null usage field', () => {
  const r = parseScriptRunnerResult(JSON.stringify({ summary: 'ok', usage: [1, 2, 3] }));
  assert.equal(r.summary, 'ok');
  assert.equal(r.usage, null);
});

test('parseScriptRunnerResult: non-finite numbers in usage → null for those fields', () => {
  const r = parseScriptRunnerResult(JSON.stringify({
    summary: 'ok',
    usage: { input_tokens: Infinity, output_tokens: NaN, total_cost_usd: 0.5 }
  }));
  assert.equal(r.usage.input_tokens, null);
  assert.equal(r.usage.output_tokens, null);
  assert.equal(r.usage.total_cost_usd, 0.5);
});

// ── readBrainKind ────────────────────────────────────────────────────────────

async function agentDir(card) {
  const root = await mkdtemp(join(tmpdir(), 'brainkind-'));
  if (card !== undefined) await writeFile(join(root, 'agent.json'), JSON.stringify(card));
  return root;
}

test('readBrainKind: gemini card selects gemini', async () => {
  const root = await agentDir({ 'x-agentmesh': { runner: { kind: 'gemini' } } });
  assert.equal(await readBrainKind(root), 'gemini');
});

test('readBrainKind: default/absent is claude', async () => {
  assert.equal(await readBrainKind(await agentDir(undefined)), 'claude');
  assert.equal(await readBrainKind(await agentDir({})), 'claude');
  assert.equal(await readBrainKind(await agentDir({ 'x-agentmesh': {} })), 'claude');
});

test('readBrainKind: existing {command} script card stays claude-family', async () => {
  const root = await agentDir({ 'x-agentmesh': { runner: { command: './run.sh' } } });
  assert.equal(await readBrainKind(root), 'claude');
});

test('readBrainKind: unknown kind falls back to claude', async () => {
  const root = await agentDir({ 'x-agentmesh': { runner: { kind: 'gpt5' } } });
  assert.equal(await readBrainKind(root), 'claude');
});

test('readBrainKind: runtime is agent-owned — a caller registry cannot override it', async () => {
  // Plant a registry.json (the caller-controlled peer spawn list) trying to claim a
  // different runtime. readBrainKind reads the SERVED agent's own agent.json only.
  const root = await agentDir({ 'x-agentmesh': { runner: { kind: 'gemini' } } });
  await writeFile(join(root, 'registry.json'), JSON.stringify({ peers: { x: { 'x-agentmesh': { runner: { kind: 'claude' } } } } }));
  assert.equal(await readBrainKind(root), 'gemini'); // own card wins; registry ignored
});
