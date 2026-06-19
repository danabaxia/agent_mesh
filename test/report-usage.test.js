// test/report-usage.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractUsage, emptyUsage, sumUsage } from '../src/report/usage.js';

test('extractUsage reads a RAW claude envelope (usage nested, cost/turns top-level)', () => {
  const env = {
    result: 'ok',
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 },
    total_cost_usd: 0.42, num_turns: 7, model: 'claude-sonnet-4-6',
  };
  assert.deepEqual(extractUsage(env), {
    input: 100, output: 20, cacheRead: 5, cacheCreation: 3, costUsd: 0.42, turns: 7, model: 'claude-sonnet-4-6',
  });
});

test('extractUsage reads a LOCAL run record (cost/turns flattened inside usage)', () => {
  const rec = { usage: { input_tokens: 9, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, total_cost_usd: 0.01, num_turns: 2 } };
  const u = extractUsage(rec);
  assert.equal(u.input, 9);
  assert.equal(u.costUsd, 0.01);
  assert.equal(u.turns, 2);
});

test('extractUsage on missing/garbage → zeros, never throws', () => {
  assert.deepEqual(extractUsage(null), emptyUsage());
  assert.deepEqual(extractUsage({}), emptyUsage());
  assert.equal(extractUsage({ usage: null }).input, 0);
});

test('sumUsage adds fields and keeps model null', () => {
  const total = sumUsage([
    { input: 1, output: 2, cacheRead: 0, cacheCreation: 0, costUsd: 0.1, turns: 1, model: 'a' },
    { input: 3, output: 4, cacheRead: 1, cacheCreation: 0, costUsd: 0.2, turns: 2, model: 'b' },
  ]);
  assert.equal(total.input, 4);
  assert.equal(total.output, 6);
  assert.equal(total.turns, 3);
  assert.ok(Math.abs(total.costUsd - 0.3) < 1e-9);
  assert.equal(total.model, null);
});
